# Security model

## Accounts and capabilities

Account state is computed centrally as `pending_password_change`, `pending_2fa`,
`active`, or `disabled`. A temporary-password session is allowlisted to minimum
session inspection, password change, logout, and the required 2FA setup steps.
React is not a security boundary.

Roles map to server-owned capabilities:

- owner/admin: all capabilities;
- editor: dashboard, content read/write, media read/upload/delete, leads
  read/write/retry, and self security;
- viewer: dashboard, content/media/leads read, and self security.

Exporting leads and managing settings remain privileged. The frontend consumes
the capability map for navigation/actions but the backend authorizes each route.

## Sessions, password changes, and 2FA

Session cookies are HttpOnly, Secure in production, time bounded, revocable, and
paired with Origin/CSRF checks for mutation. Password reset creates a temporary
password state and revokes broader access until change succeeds. Disabled users
cannot resume an old session.

TOTP setup and confirmation are separate states. Recovery codes are stored
hashed, shown once, and consumed atomically. If the device and recovery codes
are lost, an owner resets the second factor from the "Пользователи" section, or
an operator runs `admin-cli reset-2fa`; both paths go through the same module
(`server/application/user-admin.js`) and are audited. Neither is a public
bypass.

Account management is the one capability that separates `owner` from `admin`:
`users.manage` is granted to `owner` alone, because an admin able to edit
accounts could promote itself or delete the owner. Two rules make the panel
impossible to lock permanently: nobody may change the role, the access or the
existence of their own account from that section, and the last account that is
both `owner` and active cannot be demoted, disabled or deleted. Deleting an
account cascades its sessions, TOTP secret and recovery codes, while its traces
in the audit log, media and leads survive with a null author.

## Secrets and logs

Settings keys come from one registry shared by API, providers, UI contracts, and
tests. Encrypted secrets are considered set only when ciphertext, IV, and tag are
all present and authenticate successfully. GET responses return only `isSet` and
a safe preview where appropriate.

Passwords, tokens, API keys, recovery codes, lead payloads, SQL, stack traces,
filesystem paths, and full upstream errors are not returned to clients or logged.
Lead audit entries intentionally exclude name, phone, and message. Release secret
scans report only credential type and file path; a confirmed real credential must
be rotated outside this repository.

## Destructive and external actions

Mutations require CSRF and capabilities. Delivery retry is claimed durably and
idempotently; unknown delivery requires explicit confirmation. Media writes
coordinate SQLite and filesystem compensation, and maintenance reconciles both.
Settings and content changes are audited without secret values.

## Deployment model

The Node application in `server/` is the only supported production runtime.
Earlier revisions also shipped `vercel.json` and an `api/lead.js` module, which
platforms mount automatically as a serverless function — so one endpoint had two
different business behaviours: the Node route wrote a durable lead with delivery
attempts and idempotency, while the serverless one read configuration from the
environment, counted rate limits in process memory and persisted nothing.

Both are removed. `npm run verify:deployment-model` fails the build if a
serverless descriptor, a platform-mounted function directory, or a
default-exported request handler reappears, and it runs in CI.

## Trusted hosts

Every request's `Host` (or `:authority`) is validated against an allowlist built
from `PUBLIC_ORIGIN` plus `TRUSTED_HOSTS`. `X-Forwarded-Host` is honoured only
when the peer is inside `TRUSTED_PROXY_CIDRS`. A mismatch returns `421` with a
plain-text body — deliberately not the SPA shell, since rendering the shell under
an attacker-chosen name is exactly what DNS rebinding is trying to achieve.

Outside production `localhost`, `127.0.0.1` and `[::1]` are allowed
automatically. **In production they are not.** A health check that connects by IP
must have that address listed in `TRUSTED_HOSTS`, or it will receive `421`.

## Transport security settings

| Variable | Default | Effect |
|---|---|---|
| `HSTS_MAX_AGE` | `31536000` | Production only. |
| `HSTS_INCLUDE_SUBDOMAINS` | off | Previously hardcoded on, binding every subdomain of the apex without an operator decision. |
| `HSTS_PRELOAD` | off | Requires the two above; startup refuses an unqualifiable combination. |
| `ANALYTICS_ENABLED` | off | When off, no Google Tag Manager or Analytics domain appears in any CSP directive. |

`script-src` is nonce-only. Every inline `<script>` in `index.html` must carry
`nonce="__CSP_NONCE__"`; the server substitutes a fresh 16-byte nonce per
response. `style-src-elem` no longer allows `'unsafe-inline'` — only
`style-src-attr` does, because a `style` attribute cannot carry a nonce and the
dynamic ones cannot be hashed.

## Static file serving

Files are reached through `openWithinRoot()`: `lstat` rejects a symlink at the
final path component, the served descriptor is the one that was opened (rather
than a path re-opened after the check), `realpath` containment catches symlinked
intermediate directories, and device/inode are compared between the descriptor
and the `lstat` result. Symlinks are refused for release, static and media
paths, and release verification fails on an unexpected link.

## Artifacts

Two distinct generated artifacts, each with its own policy and verifier:

- **Production release** — `npm run build:release` / `verify:release` /
  `smoke:release`. Runtime only; tests are excluded.
- **Source handoff** — `npm run build:source-handoff` /
  `verify:source-handoff`. Maintainable source; tests are **required**.

Neither may contain an environment file other than `.env.example`, a runtime
database, uploaded media, logs, `node_modules`, build output, IDE or `.claude`
directories, a nested archive, a private key, or credential-shaped content.
Findings are reported as type plus path — never the value.

A test fixture that must be shaped like a real credential has to carry the
marker `NOT-A-REAL-TOKEN`, `NOT-A-REAL-KEY` or `NOT-A-REAL-SECRET` inside the
matched value. This is deliberately narrower than allowlisting a file path: an
allowlisted file keeps passing after someone pastes a live token into it.
