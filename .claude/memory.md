# Project memory

Append-only. Newest entries at the bottom of each section.

## Architecture Decisions

### 2026-07-29 — Database maintenance runs from the server, not only from the CLI

`server/lib/maintenance.js` owns retention: it is called both by the hourly tick
in `server/index.js` and by `admin-cli gc`. The lease lives in
`app_state.last_purge_at` and is taken with a single conditional UPSERT, so
exactly one process of the Passenger pool does the work, at most once a day.

The lease is moved **before** the deletions run, not after. A run that dies
mid-way must not queue every other process for a retry; a skipped day is
cheaper than a permanent DELETE loop.

Why it matters: `leads.purge_after` is a personal-data retention deadline. It
has to arrive on its own — the previous design required someone to remember an
SSH command, which in practice meant never.

### 2026-07-29 — Login escalation is wired, but never changes the response

`server/routes/admin.auth.js` now calls `createThrottle(db).registerFailure()`
on every failed factor. The returned `blocked` flag is deliberately ignored:
a distinct status code for "this address was just banned" is an oracle for
finding the threshold. The ban takes effect on the next request, in `dispatch`
(`server/app.js`), and looks like any unknown path.

`record: false` is mandatory there — the route already writes the
`login_attempts` row itself, and a second write would double both the counter
and the punishment.

### 2026-07-29 — RTL mirroring travels through a CSS variable

`.pv-hero__media` is moved by `useParallax`, which rewrites the inline
`transform` wholesale. A stylesheet rule can never win against that, so
`[dir='rtl']` sets `--pv-flip: -1` and the parallax composes
`scaleX(var(--pv-flip, 1))` into the transform it builds. Any future effect that
writes `transform` on that element must do the same.

### 2026-07-29 — Enrolment gets its own TTL, and a lost session must say so

The intermediate session between password and second factor had a single
five-minute window. That is a fair estimate for typing a code from an app that
is already installed, and a wrong one for first-time enrolment: at that moment
the user is still installing the authenticator. The window expired mid-setup,
`POST /api/admin/2fa/confirm` answered with `uniform404`, and the panel returned
to the login form **without a word** — which reads as "2FA is broken".

Two rules follow:

- `ENROLL_TTL_MS` (20 min) applies when there is no confirmed secret;
  `PENDING_TTL_MS` (5 min) when there is one. Neither is extended.
- A screen that catches a lost-session error unmounts together with its own
  message, so the reason can only be shown by the owner of the session state.
  `setSessionLostHandler` in `useSession` sets `session_lost`, but only when the
  previous status was not `anonymous`/`loading` — on a first visit "your session
  expired" would be a lie.

## Project Patterns

- Admin screens are plugged into `AdminApp` through the `screens` prop
  (`src/admin/screens/index.js`); the shell knows nothing about specific
  sections. Built-in fallbacks exist for `security` and `password`.
- `release/` is a copy of the sources prepared for deployment. It is excluded
  from ESLint (`.eslintrc.cjs`) and from Vitest (`vite.config.js` → `test.exclude`);
  without that, every test file runs twice and the counts double.
- Media library is cached per module in `src/admin/components/mediaLibrary.js`.
  Anything that uploads or deletes a file must call `invalidateMediaLibrary()`.
- Password rules live in `server/auth/password.js` and are duplicated as a live
  checklist in `screens/ChangePassword.jsx`. The duplication is intentional and
  safe in one direction only: the server must stay the stricter of the two.

## Known Issues

- The forced password change is enforced by the client. The server still serves
  other admin routes to a session whose user has `must_change_password = 1`.
- `scripts/build-release.mjs` must invoke npm through a shell: Node ≥20.15
  refuses to `execFileSync` a `.cmd` directly (EINVAL, CVE-2024-27980), and on
  Windows npm is `npm.cmd`. The command is passed as a single string so Node
  does not warn about unescaped arguments.
- HANDOFF.md items 1-5 and 8 remain open — see that file.

## Telegram delivery, Telegram CRM and Metrica (2026-08-07)

### Why "delivered" was a lie
`TELEGRAM_API_BASE` redirects every outbound Bot API call, and its only guard
lived behind `if (!config.isProduction) return` in `assertProductionConfig()`.
With the variable pointing at the local stub, a lead was recorded as `sent`,
the form said thank-you and the admin self-test reported success — while the
sales chat received nothing. The stub compounded it: it answered `ok:true` to
any payload, so a local pass proved nothing about production.

Decisions taken:
- warn on every boot in every environment when the api base is not
  `https://api.telegram.org`, not only in production;
- the admin self-test now REFUSES with `api_base_overridden` instead of
  reporting success — "success" must mean the message is in the chat;
- the stub reproduces the real API's rejections (token shape, chat_id,
  MarkdownV2 parsing, the 4096 cap). A local success is now evidence;
- `sendTelegramMessage` in admin.settings.js delegates to the single gateway.
  Two copies of the outbound call meant the self-test exercised a different
  path from the lead itself;
- Telegram errors are classified (`telegram_unauthorized`,
  `telegram_chat_not_found`, `telegram_forbidden`, `telegram_bad_markup`)
  instead of collapsing into `telegram_failed`, and the description reaches
  the operator;
- on `can't parse entities` the gateway retries once WITHOUT `parse_mode`.
  A lead that arrives as plain text beats a lead that never arrives; the
  result is flagged `degraded` so the broken template still gets fixed.

### Telegram CRM
Webhook, not long polling: Passenger runs a pool of processes, only one
`getUpdates` consumer per bot is allowed, and with no traffic there may be no
live process at all. An inbound POST is exactly what Passenger spawns for.

- `callback_data` is `v1:<leadId>:<code>:<hmac12>`, signed with a key derived
  from `APP_SECRET`. Without the signature a chat member with a userbot could
  set any status on any lead id via `messages.getBotCallbackAnswer`.
- The webhook is exempt from the ipHash block list. With `TRUSTED_PROXY_CIDRS`
  unset (the documented default) every request behind a proxy shares one hash,
  so a single honeypot hit would silently 404 Telegram for 24 h.
- The four buttons map onto the existing `leads.status` CHECK. Extending that
  CHECK would mean rebuilding a STRICT table holding personal data.

### Metrica
The integration was correct but inert: `ANALYTICS_ENABLED` defaults to false,
so a fresh deploy strips the counter entirely. Two real defects fixed —
`mc.webvisor.org` was missing from `connect-src`/`img-src` (Webvisor 2.0
uploads recordings there, so every session recording was refused while the
counter still looked alive), and `https://yandex.ru` was missing from
`img-src`, which a browser run surfaced as a blocked audience-sync pixel.
The Vite dev server used to serve the live production counter on every path
including the admin secret path; it is now stripped unconditionally in dev.

## Production readiness for the first deploy (2026-08-07)

The site had never been deployed. An audit of the first-deploy path found that
every remaining failure mode was silent, which is what these changes address.

- **`TRUSTED_PROXY_CIDRS` is now mandatory in production.** Empty meant "trust
  only the socket address", and behind Plesk/Passenger the socket address is the
  proxy — so every visitor collapsed into one `ipHash`. The lead rate limit
  became a single global budget, and one scanner hitting a honeypot path blocked
  that shared hash for 24 h, after which the entire site answered `uniform404`.
  `docs/DEPLOYMENT.md` previously advised leaving it empty, which is exactly
  wrong for this topology. `TRUSTED_PROXY_CIDRS=none` is the explicit escape
  hatch for a directly exposed process, so "forgot" and "deliberate" are
  distinguishable.
- **`DATA_DIR` is validated** (exists, writable, not inside a document root).
  Previously a bad value did not stop boot: CR-041 deliberately lets the server
  come up in limited mode when the DB is unavailable, so a wrong path read as
  "site is up" with a dead admin panel.
- **`TELEGRAM_BOT_TOKEN` shape is checked.** Non-emptiness was the only test, so
  a truncated paste failed on the first real customer's lead. The local stub was
  stricter than production.
- **`telegram_updates` is purged.** Migration 014 claimed the existing cleaner
  handled it; it did not, and the `received_at` index existed for a step that was
  never written. While adding it, `purgeBatches` was changed to derive its
  counters from `PURGE_STEPS` — the hand-written list had silently returned
  `NaN` for the new step.
- **`scripts/verify-live.mjs`** is the only check that exercises the real process
  with the real variables on the real domain; every other smoke script runs
  locally against throwaway config. It is read-only and ships inside the release
  archive so the operator does not have to fetch it. Its `getWebhookInfo`
  assertion is the one thing that catches both a forgotten webhook registration
  and a poisoned shared `ipHash`.
- **HSTS ramp documented** (300 → 86400 → 31536000). The one-year default cannot
  be withdrawn from a browser that already received it.
- Docs now state plainly what runs by itself (lead retention and the other purges
  ride an hourly leased lifecycle tick — no cron needed) and what does not
  (backups, media GC). Backups had no schedule at all, and the default
  destination was inside `DATA_DIR` — the directory a failure destroys.

## Continuous deployment (2026-08-07)

- **Push to `main` deploys.** `.github/workflows/deploy.yml` builds and verifies
  in one job and ships in another; the deploy key lives in the `production`
  GitHub environment so it is unreachable while npm build tooling runs.
- **`.gitignore` had `data/` unanchored** and was therefore excluding
  `src/data/content.js` — the landing page content. Nothing showed it in a
  working copy; a clean clone simply failed to build, because vite could not
  resolve `../data/content`. Fixed to `/data/`. Any future ignore rule meant for
  `DATA_DIR` must be anchored.
- **`npm test` requires a prior `npm run build`.** Several suites serve
  `dist/index.html` and assert a 404 for unknown paths; without `dist` they get
  503 instead. The `ci` script and both workflows now build first.
- **A colon inside a plain YAML scalar broke every deploy run.** A one-line
  `run: curl -w '<label>: HTTP %{http_code}'` parses as a nested mapping, and
  GitHub rejects the whole file before any job starts — the error surfaces only
  as "Invalid workflow file", with no job log. Inline `run:` values containing a
  colon must be block scalars.
- **`verify-live.mjs` now asserts only what the application controls.** Two
  checks failed for reasons no deploy can fix: the `Server`/`X-Powered-By`
  banners come from nginx and Passenger (this hosting plan exposes no
  "additional nginx directives" field, so it is a warning naming where to change
  it), and the host-rebinding probe never reaches the app at all — nginx picks
  the vhost by that same header and answers with the panel's default page, which
  is the desired outcome. The check now asserts the reply did not come from us.
- **The hosting subscription has a tight disk quota** (~512 MB), and a deploy
  needs roughly 25 MB of headroom: archive, staging copy and the new release
  coexist for a moment. The first quota exhaustion showed up as `tar: Cannot
  write: Disk quota exceeded` in the middle of extraction, which leaves a
  `.staging-*` directory the next run has to clear. Space was reclaimed by
  deleting `/httpdocs/node_modules` — dependencies of the superseded site, no
  longer served and restorable with `npm install` from the retained
  `package-lock.json`. Watch this before adding releases to `KEEP_RELEASES`.
- **The media library does not travel with a release.** Files live in
  `DATA_DIR/media`, which the deploy deliberately never touches, so on the first
  deploy nobody puts them there. The database still references them by content
  hash, every page answers 200, the deploy is green — and the site renders empty
  frames. Production ran this way until someone looked at it. `verify-live.mjs`
  now resolves every `/media/…` reference in `/api/site/content` and fails when
  one does not serve an image.

## Adversarial recheck of 2026-08-08

- **The homepage answered 404 to anything without a literal `text/html` in
  `Accept`.** Browsers and Googlebot send it; Telegram and WhatsApp link
  previews, `facebookexternalhit` and YandexBot send `*/*`, and some monitors
  send no header at all. A link to the site pasted into a chat unfurled into
  nothing, and Yandex — the search engine that matters in this market — saw a
  missing page. `acceptsHtml` now treats `*/*` and an absent header as HTML.
  This does not weaken the uniform 404: `/` serves the shell to everyone
  already, and unknown paths answer identically at any `Accept`.
  `server/app.homepage-accept.test.js` pins all four cases.
- **A re-run on an already deployed commit would have deleted the live
  release.** The id is derived from the commit, so the same commit yields the
  same id, and extraction opened with `rm -rf "$TARGET"` on the directory
  `current` points at. In that same case `PREVIOUS_RELEASE == RELEASE_ID`, so
  the automatic rollback would relink `current` to itself and report success.
  The remote script now detects an already live id and only restarts.
- **`[dir='rtl']` outranks a media query.** The RTL rule pinned
  `background-position: left center`, which beat the phone rule by selector
  specificity and framed the empty half of the hero artwork in Arabic. The crop
  is chosen in the image's coordinates, so `right center` is correct for both
  directions — the mirror, not the crop, moves the subject.
- **`transform: none` in a media query is a trap next to this parallax.** The
  inline style always wins while JS runs, so the rule did nothing — except
  under `prefers-reduced-motion`, where the hook clears the inline style and
  the rule would have silently killed the RTL mirror.

## Управление учётными записями (2026-08-08)

- **`users.manage` — единственная капабилити, которой у роли `admin` нет.** До
  этого `owner` и `admin` не различались ничем, то есть вторая роль была
  украшением. Администратор, способный править учётки, мог бы повысить себя и
  удалить владельца, поэтому раздел «Пользователи» открыт только владельцу.
- **Два правила делают панель незапираемой.** Свою учётку в этом разделе не
  меняют вовсе (роль, доступ, удаление — три способа выйти без возврата), а
  последнего владельца со статусом `active` нельзя ни понизить, ни отключить,
  ни удалить. Отключённый владелец в счёт не идёт: войти он не может.
  Через HTTP правило последнего владельца недостижимо — единственный кандидат
  это учётка самого действующего владельца, а её раньше отсекает `self_target`;
  живёт правило ради CLI, где действующего пользователя нет.
- **Правила лежат в `server/application/user-admin.js`, а не в маршруте.** Те же
  операции выполняет `scripts/admin-cli.mjs`, и до этого модуля они существовали
  только там. Две реализации разошлись бы на первом изменении — например,
  «сброс 2FA удаляет и незавершённое подключение» (CR-063) знал бы только CLI.
- **`DELETE` — единственный маршрут админки с `contentTypes: null`.** Третий
  барьер CSRF проверяет тип тела; тела у запроса нет, а простая HTML-форма
  метод DELETE не отправит вовсе. Origin и токен сессии продолжают работать.
- **Удаление учётки не стирает историю.** Сессии, секрет TOTP и коды
  восстановления уходят каскадом, а `audit_log`, медиа и заявки объявлены
  `ON DELETE SET NULL` — кто что менял, видно и после увольнения.
