# PROHVAC

Public multilingual HVAC landing page with a hidden administrative console,
SQLite-backed content and leads, Telegram delivery, optional DeepL translation,
and filesystem-backed media storage.

## Requirements

- Node.js `>=22.13 <25` (the server uses built-in `node:sqlite`)
- npm with the committed `package-lock.json`
- a local filesystem for `DATA_DIR`; network filesystems are not supported for WAL

## Local development

```bash
npm ci
npm start
```

`npm start` runs the Telegram mock and the dev server together and refuses to
start when `TELEGRAM_API_BASE` is missing or non-local, so a test lead can never
reach the real sales chat.

The development configuration uses recognizable non-production placeholders.
Copy `.env.example` to an ignored local environment file only when you need to
override defaults. Never commit `.env`, `.env.local`, SQLite databases, or uploads.

Useful gates:

```bash
npm run lint
npm run verify:deployment-model   # one production runtime only
npm test
npm run build
npm run smoke:migrations
npm run smoke:production
npm run smoke:telegram         # lead -> SQLite -> Telegram, end to end
npm run build:release
npm run verify:release
npm run smoke:release
npm run build:source-handoff      # maintainable source, distinct from the release
npm run verify:source-handoff
```

`npm run ci` runs all of the above in order. CI additionally checks that the
generated tree stays clean after a build.

Every check above runs **locally**, against throwaway configuration. After a
deploy, verify the real thing:

```bash
TELEGRAM_BOT_TOKEN=<token> npm run verify:live -- https://www.prohvac.uz
```

It is read-only — no lead is submitted and nothing is posted to the chat. With
the bot token present it also asks Telegram whether the status-button webhook is
registered, which is the one assertion that catches a deployment where
everything looks fine and the chat buttons silently do nothing. See
`docs/DEPLOYMENT.md`.

## Runtime layout

- `src/`: React public site and admin UI
- `server/http`/`server/routes`: HTTP adapters and guards
- `server/application`: request-independent workflows and state machines
- `server/repositories`: durable lead/delivery access
- `server/integrations`: injectable external providers
- `server/policies`: account and capability decisions
- `server/db/migrations`: append-only SQLite migrations
- `shared`: contracts used by server and browser
- `DATA_DIR/app.sqlite`: runtime database
- `DATA_DIR/media`: uploaded content-addressed images

The application runs through `app.cjs`. On startup it validates production
configuration and applies pending migrations atomically. The first administrator
is created with `node scripts/admin-cli.mjs create-user --username <name>`;
every account after that is managed from the panel, in the "Пользователи"
section, which only the `owner` role can open.

## Deployment

A push to `main` deploys. `.github/workflows/deploy.yml` runs lint, tests and
every smoke script, builds the release archive, ships it to the host, flips the
`current` symlink and finally verifies the live domain with
`scripts/verify-live.mjs`. Nothing on the server is built there — the Plesk
chroot has no `node`, `git` or `npm`.

`docs/DEPLOYMENT.md` covers the required secrets, the constraints the chroot
imposes on the remote script, and the manual first-deploy sequence.

## Security summary

Administrative authorization is enforced by the server. A user with a temporary
password may only inspect the minimum session state, change the password, finish
the required 2FA flow, or sign out. Role capabilities are returned by the server
for UI presentation but are checked again for every API operation.

Secrets stored through the settings UI are encrypted with `APP_SECRET` and are
never returned to the browser. Losing or rotating `APP_SECRET` makes existing
encrypted settings unreadable and revokes all sessions.

See:

- [Deployment guide](docs/DEPLOYMENT.md)
- [Operations guide](docs/OPERATIONS.md)
- [Security model](docs/SECURITY_MODEL.md)
- [Release guide](docs/RELEASE.md)
