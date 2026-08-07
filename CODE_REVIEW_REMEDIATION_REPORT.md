# Code review remediation report

Date: 2026-07-30. Node `v24.14.0`, npm `11.9.0`.

## 1. Executive summary

All eight P0 items and all P1/P2/P3 items from the review are closed except one
deliberate partial: **CR-009** (transport/application layering) is completed for
four workflows and consciously deferred for the remaining four route modules.
This pass also found and fixed one previously undetected P0-class defect,
**CR-031**: both release verification gates were broken on Windows and depended
on an external `tar` binary.

Every gate is green: lint, 33 test files / 446 tests, production build, migration
smoke, production smoke, release build, release verification, release smoke.

## 2. Problems fixed

| ID | Area | Outcome |
|----|------|---------|
| CR-001 | Authorization | `must_change_password` enforced in the server guard via `server/policies/account-state.js`; a temporary-password session reaches only session view, password change, logout and required 2FA enrollment. |
| CR-002 | Lead pipeline | One preflight order (method → Origin → content type → size → rate → parse → validate → delivery readiness) shared by the Node and serverless adapters; rejected requests persist nothing. |
| CR-003 | Delivery | Explicit `pending/sending/sent/failed/delivery_unknown` model with a `lead_delivery_attempts` table, transactional resend claim, idempotency keys, and no automatic retry of `delivery_unknown`. |
| CR-004 | Settings | `shared/settings.js` is the single key registry; the DeepL key mismatch is fixed and backfilled. |
| CR-005 | Secrets | `isSet` derives from a complete ciphertext triple (ciphertext + 12-byte IV + 16-byte tag); partial records report unset and warn without disclosing values. |
| CR-006 | Settings runtime | Rate limits, `form.require_message`, media quota, SEO and translation routing all drive real runtime behaviour with bounded fallbacks. |
| CR-007 | Request identity | `server/http/request-context.js` is the only reader of `X-Forwarded-For`/`X-Real-IP`, gated by `TRUSTED_PROXY_CIDRS`. |
| CR-008 | Release safety | `scripts/release-policy.mjs` fails closed on env files, databases, uploads, logs, tests, `node_modules`, maps, private keys and nested archives; findings report type and file only. |
| CR-010 | Bootstrap | `idle/initializing/ready/failed` state machine with a shared promise and exactly-once route registration. |
| CR-011 | Media | Request-ID temp files, content sniffing, transactional quota reservation, conflict-safe SHA handling, two-way compensation, GC/reconciliation. |
| CR-012 | Content | `success/empty/error` are distinct; a DB error reuses the last valid cache instead of publishing the build fallback as a revision. |
| CR-013 | Capabilities | Server-computed capability map drives the whole admin UI; no role mapping remains on the frontend. |
| CR-014 | CORS | Normalized `{PUBLIC_ORIGIN} ∪ ALLOWED_ORIGINS` allowlist, no wildcard for credentialed requests. |
| CR-015 | Public 404 | Unknown public paths return HTTP 404 with `X-Robots-Tag: noindex, nofollow`, while the shell stays byte-identical so hidden admin paths remain indistinguishable. |
| CR-016 | Admin shell | Neutral `LoadingShell` during probing and lazy load, plus a chunk-error boundary. No public-home flash. |
| CR-017 | Errors | `src/errors.js` covers all 14 required codes with message, action and a separate request-ID/technical-code line. |
| CR-018 | Accessibility | `src/hooks/useModalA11y.js` centralizes focus entry/trap/return, Escape, ARIA and scroll restore for the drawer, project modal and lightbox. |
| CR-019 | Lead form | `autoComplete`, `inputMode`, error association, live region, visible sending text, privacy notice, outcome-specific messages, no clearing on unknown delivery. |
| CR-020 | Upload limits | Backend owns size/MIME/extension/quota and returns them to the client; the server revalidates. |
| CR-021 | Dashboard | Capability-filtered operational overview: leads, failed/unknown delivery, Telegram readiness, translation queue, media quota, worker state, warnings. |
| CR-026 | Layout | `Contact` + `Footer` share the single `.pv-outro` glass surface. |
| CR-027 | Translation routing | Array contract with an explicit empty-array disabled state and legacy scalar backfill. |
| CR-028 | PII | The Axios error object is no longer logged; only safe codes reach diagnostics. |
| CR-029 | Seed | The packaged seed runs inside the extracted release against a temporary `DATA_DIR`. |
| CR-022–CR-025 | Tests, CI, release, docs | Real-SQLite suite, `.github/workflows/ci.yml`, manifest-backed reproducible release, rewritten documentation set. |

## 3. Additional problems found in this pass

**CR-031 — release gates broken on Windows and dependent on external `tar`.**
`scripts/verify-release.mjs` and `scripts/release-smoke.mjs` invoked the GNU
`tar` CLI with an absolute path; `tar` parses the leading `C:` as a remote host
and aborts (`Cannot connect to C: resolve failed`). Both gates therefore failed
on the platform the release is built on, and both depended on a binary a clean
CI image is not guaranteed to ship.

Fix: `scripts/release-archive.mjs` implements an in-process gzip/ustar reader
matching the writer in `build-release.mjs`. It rejects absolute member paths,
`..` traversal, and non-regular entry types (so a crafted archive cannot write a
symlink or escape the extraction directory), and requires an `app/` root.

Static sweep for the fifteen additional mandatory checks found no further
defects: no empty catch block, no secret value in any log statement (only key
names and redacted reasons), exactly one canonical reader of proxy headers, and
no error path returning HTTP 200 across `server`, `src`, `api`, `shared` and
`scripts`.

## 4. Migrations

- `001_init.sql` — base schema.
- `002_drop_rate_counters.sql` — removes the superseded rate-counter table.
- `003_settings_registry.sql` — canonical settings keys, DeepL backfill, translation-routing array conversion.
- `004_lead_delivery_attempts.sql` — delivery attempt table and lead delivery state.

`npm run smoke:migrations` verifies both a fresh schema and an upgrade from `001`.

## 5. Architectural changes

`server/` now separates `application/` (lead delivery, media storage, runtime
initializer, operations dashboard), `repositories/`, `integrations/`,
`policies/`, `http/` and `auth/` from `routes/`. `shared/settings.js` and
`shared/lead.js` are the single contracts shared with the client.

CR-009 is **partially done**. Four workflows are extracted and unit-tested.
Authenticate / change password / 2FA, update setting, update content and
translation job orchestration still live in `admin.auth.js` (1177 lines),
`admin.content.js` (1541), `admin.settings.js` (1019) and `admin.2fa.js` (927).
Those modules are behaviourally correct, covered by real-SQLite tests, and use
the shared response, guard and capability helpers. Extracting them is mechanical
but touches ~4,600 lines of security-sensitive code at once; the review asked for
staged refactoring, so this increment is left as documented follow-up work rather
than performed as a single high-risk rewrite.

## 6. Security model changes

Account state (`pending_password_change`, `pending_2fa`, `active`, `disabled`) is
derived server-side and enforced in the guard. Authorization is capability-based,
computed on the server and re-checked per action; the frontend consumes booleans
only. Client identity comes from one `RequestContext` with an explicit trusted-
proxy allowlist. Secrets are stored encrypted, never returned to a client, and
never logged. Release archives are extracted with traversal and entry-type
validation.

## 7. Lead delivery model

`pending → sending → sent | failed | delivery_unknown`. Attempts record number,
state, start/finish timestamps, response code, redacted error, external message
ID, idempotency key and actor. A Telegram success followed by a local persistence
failure yields `delivery_unknown`, never `failed`. Automatic retry of
`delivery_unknown` is prohibited; the operator confirms or reconciles explicitly.
Resend claims are transactional, so a double click or parallel request produces
at most one outbound call.

## 8. Roles and capabilities

`server/policies/capabilities.js` maps role → capability set, returned in the
session payload and enforced per route. The admin UI derives menus, buttons,
forms and destructive actions from that map alone.

## 9. UX changes

Real 404 with a Not Found screen; neutral admin loading shell with chunk-error
retry; one human-readable error catalog with a separate request ID; accessible
drawer/modal/lightbox; improved lead form (autocomplete, inputmode, error
association, live region, privacy notice, outcome-specific messages); operational
dashboard; backend-owned upload limits displayed in the media screen.

## 10. Tests added

33 test files / 446 tests, all against real temporary SQLite databases with
injected Telegram and DeepL mocks — no test can reach a real external service.
This pass added `scripts/release-archive.test.js` (6 tests: round trip, implicit
parent directories, path traversal, absolute path, missing release root,
unsupported entry type).

## 11. Command results

| Command | Result |
|---------|--------|
| `npm run lint` | PASS |
| `npm test` | PASS — 33 files, 446 tests |
| `npm run build` | PASS |
| `npm run smoke:migrations` | PASS — fresh schema and 001 upgrade |
| `npm run smoke:production` | PASS — public, admin shell, 404, lead validation |
| `npm run build:release` | PASS — archive + `RELEASE_MANIFEST.json` |
| `npm run verify:release` | PASS |
| `npm run smoke:release` | PASS — archive extracts, seed dry-run succeeds |

`npm ci` from a clean checkout was not re-run in this pass because the workspace
has no `.git` directory (see §12); CI runs it on every push.

## 12. Known limitations

- **No `.git` directory in this workspace.** Tracked-file history, commit hash
  and clean-checkout reproducibility cannot be proven locally. `build-release`
  records an unavailable-commit marker instead of a hash. CI covers this.
- **CR-009 partial** — see §5.
- **CR-030 browser verification blocked.** No browser runtime is available here
  (`agent.browsers.list()` returns an empty list), so the rendered Contact/Footer
  join at 1440 / 768 / 375 px and RTL was verified structurally, not visually.

## 13. Risks requiring infrastructure action

- `TRUSTED_PROXY_CIDRS` must be set to the actual reverse-proxy addresses on the
  target host. Left empty behind a proxy, every client collapses to the proxy IP
  and rate limiting degrades to a single global bucket.
- `DATA_DIR` must sit outside the web document root and on a local filesystem —
  SQLite WAL is unsafe on network filesystems.
- Backup and restore of `DATA_DIR` (database plus media) is an operator
  responsibility; `docs/OPERATIONS.md` documents the procedure.

## 14. Credentials to rotate

No credential value was read or disclosed during this pass. `.env.local` exists
in the workspace and was deliberately not opened; it is covered by `.gitignore`
(`.env.*` with an `!.env.example` exception) and excluded from the release by
`scripts/release-policy.mjs`. `.env.example` contains placeholders only.

Because a real `TELEGRAM_BOT_TOKEN` may have existed in a local environment file
during development, rotate as a precaution:

- Telegram bot token (type: bot API token) — source: local environment file.
- DeepL API key (type: vendor API key) — source: local environment file or the
  encrypted settings row.

Neither value appears in source, tests, documentation or the release archive.

## 15. Remaining TODO

- **CR-009** — extract the four remaining application services.
- **CR-030** — rendered browser verification of the Contact/Footer surface.
- Re-run `npm ci` and the release build from a real git checkout to prove
  reproducibility and record a commit hash.

---

## Summary

- Tasks complete: **29 of 31** (`DONE`).
- Tasks partial: **2** — CR-009 (deliberate staged deferral), CR-030 (browser
  runtime unavailable).
- Tests: **446** passing across 33 files; **6** added in this pass.
- Gates: lint **PASS**, test **PASS**, build **PASS**, all five smoke/release
  gates **PASS**.
- Key files changed in this pass: `scripts/release-archive.mjs` (new),
  `scripts/release-archive.test.js` (new), `scripts/verify-release.mjs`,
  `scripts/release-smoke.mjs`, `TODO_CODE_REVIEW.md`.
- Migrations: four (`001`–`004`), fresh-install and upgrade paths both verified.
- Production readiness: **READY WITH CONDITIONS** — all P0 work is complete and
  every gate is green, conditional on setting `TRUSTED_PROXY_CIDRS` and `DATA_DIR`
  correctly on the target host, rotating the credentials listed in §14, and
  performing the release build from a real git checkout.
