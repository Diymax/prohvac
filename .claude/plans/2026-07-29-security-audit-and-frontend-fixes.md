# Security audit follow-up and frontend fixes — 2026-07-29 ✅ DONE

## Scope

Two requests, executed in one session:

1. Full-repository security audit (`/super-review`), then fix everything found.
2. Frontend and admin-panel work: Playwright audit of admin UX and first-time 2FA
   enrolment, footer and responsive behaviour across viewports, Arabic/RTL
   correctness, content-management ergonomics, admin UI polish, password
   strength, release preparation.

Decisions confirmed by the user before implementation:

- Delete nothing from the working tree; only build the release archive.
- Improve admin UI within the existing `adm-*` design system, no redesign.
- Password policy: block dictionary and keyboard-run passwords, require
  character classes, force a change at login when the stored password fails
  the new rules.
- Playwright may start the dev server and use the local `data/` database with
  the Telegram mock.

## Audit findings that were fixed

| # | Finding | Fix |
|---|---|---|
| 1 | `server/auth/throttle.js` escalation module was never called from the login route — `detectStuffing` and `ip_blocks` bans by `login_bruteforce` could not fire | `escalateFailure()` wired into `refuse()` and `rejectSecondFactor()` in `server/routes/admin.auth.js`; response shape deliberately unchanged to avoid an oracle |
| 2 | `gc` existed only as a CLI command, so `leads.purge_after` never triggered and counter tables grew unbounded on a 500 MB disk | New `server/lib/maintenance.js` (`runMaintenance`, `claimMaintenance`, `compactDatabase`); hourly tick in `server/index.js` with a once-a-day lease in `app_state.last_purge_at`; `admin-cli gc` reuses the same module |
| 3 | `throttle.hit('login:user:<name>')` ran before the per-IP limit check, so a stream of unique usernames grew `rate_limit` from unauthenticated requests | Username bucket is only touched while the IP bucket still allows |
| 4 | Eight dependencies declared with `^` ranges (CLAUDE.md §9) | Pinned to the exact versions from the lockfile |
| 5 | Scanner reported 8 CRIT SQL-injection hits | All false positives — verified that every template literal interpolates module constants or whitelisted descriptors |

`server/lib/maintenance.test.js` and `server/routes/admin.auth.test.js` cover
the new behaviour, including the wiring itself — the exact thing that had been
absent.

## Frontend findings that were fixed

Found by a 45-agent parallel audit, each finding adversarially verified before
being acted on: 33 confirmed out of 39 candidates.

RTL/Arabic:

- Parallax inline `transform` overwrote the hero mirror, leaving the Arabic
  first screen visually empty. Mirroring now travels through `--pv-flip`, which
  the parallax composes into its own transform.
- Partner marquee used `animation-direction: reverse` against a negative
  keyframe; replaced with a dedicated `pv-marquee-rtl` keyframe.
- No Arabic-capable font was loaded; added `Noto Sans Arabic`.
- Project card kept `text-align: left`; third background blob and header
  padding were not mirrored.

Responsive:

- `.pv-grid-projects`, `.pv-about`, `.pv-contact` used hard `minmax(Npx, 1fr)`
  minimums larger than the available width at 320-360px — cards were silently
  clipped by `overflow-x: hidden`. Now `minmax(min(Npx, 100%), 1fr)`.
- Empty grid remainders on tablet widths for advantages, stats and contacts.
- Modal close button dropped below the description at ≤900px.
- Footer links were 18-20px tall touch targets; now 44px.
- Two sections carried inline padding in JSX and therefore escaped the mobile
  media query; moved to `.pv-section--marquee` / `.pv-section--contact`.

Readability: primary and coral buttons, project link, form errors, footer
copyright and warm stat colour all failed WCAG AA; recoloured.

Admin UI: status badges had no colour modifiers in CSS, the quota bar could
never turn red (`--danger` vs `--full` class mismatch), textarea/select had
`outline: none` on focus and no disabled styling, inline filter fields kept
`width: 100%`.

## Admin UX work

- **Password change screen did not exist.** `POST /api/admin/password` was
  never called from `src/` — the panel showed "your password is temporary,
  change it" with no way to do so. Added `screens/ChangePassword.jsx`,
  `session.changePassword`, and a gate in `AdminApp` that hides the panel until
  the password is changed.
- Media picker (`components/MediaPicker.jsx` + `components/mediaLibrary.js`)
  replaces typing numeric file IDs for covers, logos, icons and galleries.
- Publish/hide directly from the entity list.
- Unsaved-changes guard when switching entity tabs or closing the tab.
- Clearing the bot token now requires confirmation.

## Verification

- `npm run lint` — clean; `npm test` — 333 tests, 14 files.
- Playwright: 21/21 admin checks (login → 2FA enrolment with a generated TOTP →
  forced password change → all sections → media picker), zero console errors,
  zero 4xx/5xx.
- Playwright: 16 viewport widths from 320 to 1920 — no horizontal overflow, no
  empty grid remainders.
- Playwright: 9 RTL checks pass; reveal animation confirmed working in Arabic.
- `npm run build:release` produces a 3.40 MB archive.

## Left open

- The forced password change is enforced client-side only; the server does not
  reject other admin routes while `must_change_password = 1`.
- HANDOFF.md items 1-5 and 8 (proxy trust list, session/UA binding, inert
  settings keys, DB-error vs empty-table, lead written before rate check,
  contract tests) were out of scope and remain open.
