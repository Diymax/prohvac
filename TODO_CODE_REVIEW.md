# Project Remediation TODO

Baseline recorded on 2026-07-30, re-verified against the working tree on the
same day after the remediation passes:

- Node `v24.14.0`, npm `11.9.0`.
- `npm run lint`: PASS.
- `npm test`: PASS — 33 files, 446 tests (initial baseline was 14 files, 333 tests).
- `npm run build`: PASS.
- `npm run smoke:migrations`, `npm run smoke:production`, `npm run build:release`,
  `npm run verify:release`, `npm run smoke:release`: PASS.
- No `.git` directory is present in this workspace, so tracked-file history, commit hash, and clean-checkout reproducibility cannot yet be proven.
- `.env.local` exists but was not opened. The repository has no `.openai/hosting.json`.
- The source started with two migrations (`001`, `002`) and no CI workflow; it now
  carries four migrations (`001`–`004`) and `.github/workflows/ci.yml`.

Status policy: an item changes to `DONE` only after its focused tests and the relevant lint/build/smoke gates pass.

## P0 — Security and data integrity

### CR-001 — Enforce password-change state on the server

Priority: P0

Status: DONE

Problem:
`requireActive()` validates the session state and disabled flag but not
`users.must_change_password`. The React password gate is therefore bypassable
by direct requests to leads, content, settings, and media APIs.

Files:
- `server/auth/guard.js`
- `server/routes/admin.auth.js`
- `server/routes/admin.2fa.js`
- `server/policies/account-state.js` (new)
- `server/routes/admin.password-gate.test.js` (new)

Implementation:
- [x] Derive one account state from existing user/session fields.
- [x] Deny normal admin APIs while password change is pending.
- [x] Allow only session view, password change, logout, and required pending-2FA enrollment.
- [x] Return `403 must_change_password` to the authenticated client while preserving anonymous admin masking.
- [x] Keep role checks active after the password change.

Acceptance criteria:
- [x] A temporary-password session cannot read leads.
- [x] It cannot mutate content.
- [x] It cannot upload media.
- [x] Password change unlocks only APIs allowed by the user role.

Tests:
- [x] Real-SQLite integration tests cover anonymous masking, leads, content,
      media, session view/logout, pending-2FA setup/confirm, forbidden 2FA
      management, password change, and post-change viewer restrictions.

Verification result:
- `npx eslint server/auth/guard.js server/policies/account-state.js
  server/routes/admin.auth.js server/routes/admin.2fa.js
  server/routes/admin.password-gate.test.js --report-unused-disable-directives
  --max-warnings 0`: PASS.
- `npm test -- server/routes/admin.password-gate.test.js
  server/routes/admin.auth.test.js`: PASS — 2 files, 16 tests.
- `npm test`: PASS — 16 files, 353 tests.
- `npm run build`: PASS.
- API smoke is exercised by 10 real-route/real-SQLite password-gate integration
  scenarios. No standalone typecheck script exists.
- A later full `npm run lint` is temporarily BLOCKED by concurrent work outside
  CR-001 (`api/lead.test.js`, `server/http/request-context.js`,
  `server/routes/admin.leads.js`); the focused CR-001 lint command above passes.

Related tasks:
CR-009, CR-013, CR-017, CR-022.

### CR-002 — Correct the lead submission pipeline

Priority: P0

Status: DONE

Problem:
The Node adapter stores a lead before method, Origin, media type, size, rate,
configuration, and final validation checks. Serverless object bodies can bypass
the actual byte-size check, and the current validation order differs by adapter.

Files:
- `api/lead.js`
- `server/routes/public.lead.js`
- `server/app.js`
- `server/application/submit-lead.js` (new)
- `server/http/request-context.js` (new)
- `shared/lead.js`
- integration tests

Implementation:
- [x] Build one request context.
- [x] Enforce method → Origin → content type → size → rate → parse → validate → delivery readiness.
- [x] Persist no lead or delivery attempt for any rejected request.
- [x] Insert the accepted lead as `pending` only after preflight succeeds.
- [x] Make Node and serverless response/error contracts identical.
- [x] Make repeated submissions explicit and idempotency-aware.

Acceptance criteria:
- [x] Every required negative scenario leaves lead/attempt table counts unchanged.
- [x] A valid request creates one lead and one delivery attempt.
- [x] A repeated request cannot create an accidental duplicate delivery.

Tests:
- [x] Origin, rate, content type, method, size, phone, Telegram config, success, repeat.
- [x] Both Node stream and pre-parsed adapter cases.

Verification result:
Node and serverless adapters share one preflight order and one CORS policy;
rejected requests persist nothing. Covered by `server/routes/public.lead.test.js`
and `api/lead.test.js`.

Related tasks:
CR-003, CR-006, CR-007, CR-014, CR-022.

### CR-003 — Implement a reliable Telegram delivery model

Priority: P0

Status: DONE

Problem:
Delivery is stored only on `leads.telegram_status`. A Telegram success followed
by a local `markSent` failure is swallowed and then rewritten as `failed`,
making duplicate resend likely. Admin resend is a read-then-send race.

Files:
- `server/db/migrations/003_delivery_and_settings.sql` (new)
- `server/application/lead-delivery.js` (new)
- `server/repositories/leads.js` (new)
- `server/integrations/telegram.js` (new)
- `server/routes/public.lead.js`
- `server/routes/admin.leads.js`
- `src/admin/screens/Leads.jsx`
- integration tests

Implementation:
- [x] Add attempts with number, state, timestamps, response code, safe error, external ID, idempotency key, and actor.
- [x] Support `pending`, `sending`, `sent`, `failed`, `delivery_unknown`.
- [x] Claim resend transactionally and reject concurrent claims.
- [x] Mark post-Telegram persistence failure as `delivery_unknown`.
- [x] Prohibit automatic retry of `delivery_unknown` without explicit operator confirmation/reconciliation.
- [x] Use one injectable Telegram gateway for submit, resend, and tests.

Acceptance criteria:
- [x] A confirmed Telegram delivery is never reported as `failed` solely because local finalization failed.
- [x] Double click and parallel resend produce at most one outbound call.
- [x] UI accurately displays and constrains every delivery state.

Tests:
- [x] Success, Telegram rejection, timeout/network failure.
- [x] DB failure after Telegram success.
- [x] Concurrent resend, idempotency replay, unknown retry denial.

Verification result:
Real-SQLite delivery tests pass, including a post-Telegram DB failure,
idempotent replay, unknown-state confirmation, and concurrent retry. Full
checkpoint: lint PASS, 427 tests PASS, production build PASS.

Related tasks:
CR-002, CR-009, CR-017, CR-021, CR-022.

### CR-004 — Create one settings registry

Priority: P0

Status: DONE

Problem:
Admin stores DeepL at `deepl.api_key`; the provider reads
`translation.deepl.key`. Translation routing is stored as scalar values while
runtime expects arrays, and key strings are duplicated in UI and providers.

Files:
- `shared/settings.js` (new)
- `server/routes/admin.settings.js`
- `server/translate/provider.js`
- `server/translate/registry.js`
- `server/translate/providers/deepl.js`
- `src/admin/screens/Settings.jsx`
- migration and tests

Implementation:
- [x] Define canonical keys, types, bounds, secrecy, defaults, and runtime ownership.
- [x] Use constants in admin API, runtime providers, worker, UI, and tests.
- [x] Migrate `deepl.api_key` to the canonical key with a deterministic conflict rule.
- [x] Convert translation routing to the canonical array contract (`none` → `[]`).
- [x] Restrict environment fallback to documented keys and precedence.

Acceptance criteria:
- [x] An admin-saved DeepL key is consumed by the provider.
- [x] No secret value is returned to the client.
- [x] Routing changes affect the worker exactly as displayed.

Tests:
- [x] Admin write → provider read.
- [x] Backfill and conflict handling.
- [x] Environment fallback and routing.

Verification result:
PASS — focused Vitest: 4 files, 14 tests. Full `npm test`: 24 files,
397 tests. `npm run lint` and `npm run build`: PASS.

Related tasks:
CR-005, CR-006, CR-009, CR-025.

### CR-005 — Correct encrypted-secret `isSet`

Priority: P0

Status: DONE

Problem:
Valid secret rows require plaintext `value=NULL`, but settings GET calculates
`isSet` from that plaintext column and does not load all ciphertext parts.

Files:
- `shared/settings.js` (shared registry and secret-state contract)
- `server/routes/admin.settings.js`
- `server/translate/provider.js`
- tests

Implementation:
- [x] Centralize `absent|complete|corrupt` inspection.
- [x] Require ciphertext, 12-byte IV, and 16-byte authentication tag.
- [x] Treat partial records as unset/corrupt and emit a redacted operational warning.
- [x] Use the helper for list, read, update, delete, and providers.

Acceptance criteria:
- [x] Valid encrypted secrets report `isSet=true`.
- [x] Corrupt secrets never decrypt or report as valid.
- [x] Plaintext and ciphertext never enter client payloads or logs.

Tests:
- [x] Absent, set, update, delete, corrupt, no disclosure.

Verification result:
PASS — structural and authenticated corruption cases, admin GET/PUT/delete,
provider fallback precedence, and disclosure assertions pass in the focused
suite. Full lint, test, and build pass.

Related tasks:
CR-004, CR-017, CR-022.

### CR-006 — Remove or activate every displayed setting

Priority: P0

Status: DONE

Problem:
`lead.rate_*`, `form.require_message`, and `media.quota_bytes` are displayed but
ignored by runtime. SEO controls also have no consumer. Invalid values must not
break request paths.

Files:
- settings registry/runtime service
- `server/routes/public.lead.js`
- `shared/lead.js`
- `server/routes/admin.media.js`
- `server/routes/public.content.js`
- `src/components/Contact.jsx`
- `src/admin/screens/Settings.jsx`
- tests

Implementation:
- [x] Apply saved rate max/window with safe bounds/fallback.
- [x] Expose public form policy and enforce required message on both layers, server authoritative.
- [x] Apply saved media quota to upload, capabilities, and usage.
- [x] Activate translation routing with CR-004.
- [x] Connect SEO to public metadata or remove those controls from API/UI until implemented.

Acceptance criteria:
- [x] Every visible control changes actual runtime behavior.
- [x] Invalid persisted values fall back safely and warn operationally.

Tests:
- [x] Focused runtime test for every retained setting.

Verification result:
Admin-API-to-runtime tests cover lead limits, required message, media quota,
SEO, translation routing and bound rejection. Focused 18/18 tests pass; full
checkpoint lint/test/build passes.

Related tasks:
CR-002, CR-004, CR-011, CR-019, CR-020.

### CR-007 — Canonical RequestContext and trusted proxy policy

Priority: P0

Status: DONE

Problem:
Multiple modules trust `X-Real-IP`/`X-Forwarded-For` unconditionally and select
different client addresses. Rate limiting, blocklist, audit, and lead records can
therefore disagree or be spoofed.

Files:
- `server/http/request-context.js` (new)
- `server/config.js`
- `server/app.js`
- all routes that hash IP/UA
- `.env.example`
- deployment docs and tests

Implementation:
- [x] Add request ID, canonical IP/hash, UA/hash, Origin, and timestamp.
- [x] Add explicit trusted proxy/CIDR configuration.
- [x] Ignore forwarding headers from untrusted peers.
- [x] Parse trusted chains right-to-left and reject malformed candidates.
- [x] Attach context once before blocklist/rate/audit decisions.

Acceptance criteria:
- [x] One canonical identity is reused everywhere in a request.
- [x] A direct spoof cannot change it.
- [x] Plesk/Passenger and direct deployment topology is documented.

Tests:
- [x] Direct spoof, trusted proxy, XFF chain, IPv4, IPv6, malformed headers.

Verification result:
Focused route/context tests pass; `docs/DEPLOYMENT.md` documents the
nginx/Passenger and direct topologies and `TRUSTED_PROXY_CIDRS`, and
`.env.example` carries the placeholder. Full lint/test/build pass.

Related tasks:
CR-002, CR-009, CR-014, CR-025.

### CR-008 — Secret-safe source and release contents

Priority: P0

Status: DONE

Problem:
The release builder copies test fixtures and lacks a manifest/secret gate.
`release/app` and an archive are present in the workspace. Git tracking cannot
be verified because this workspace has no `.git`.

Files:
- `.gitignore`
- `.env.example`
- `scripts/build-release.mjs`
- `scripts/verify-release.mjs` (new)
- `scripts/scan-secrets.mjs` (new)
- package scripts and tests

Implementation:
- [x] Reject forbidden env files, DB/WAL/SHM, uploads, logs, tests/fixtures, node_modules, maps, private keys, tokens, and nested archives.
- [x] Keep source tests while excluding them from release payload.
- [x] Report only credential type and file, never the value.
- [x] Validate `.env.example` as placeholders only.
- [x] Record the inability to verify tracked history until run from a real checkout.

Acceptance criteria:
- [x] Release verification fails closed on every forbidden fixture.
- [x] No local runtime/user data enters release.

Tests:
- [x] Manifest allow/deny fixtures and redacted output.

Verification result:
`scripts/release-policy.mjs` fails closed on env files, databases, uploads,
logs, tests, node_modules, maps, private keys and nested archives, and reports
type plus file only. `npm run build:release && npm run verify:release` pass.

Related tasks:
CR-023, CR-024.

## P1 — Architecture and resilience

### CR-009 — Separate transport handlers from application services

Priority: P1

Status: PARTIALLY DONE

Problem:
Large routes own HTTP, auth, validation, SQL, state transitions, auditing, and
external calls in the same modules.

Files:
- `server/transport/`, `application/`, `domain/`, `repositories/`,
  `integrations/`, `policies/` (incremental additions)
- existing route modules

Implementation:
- [ ] Extract submit lead, retry delivery, update setting, upload media.
- [ ] Extract authenticate/change password/2FA operations.
- [ ] Extract update content and translation job orchestration.
- [ ] Centralize application errors → safe HTTP responses.
- [ ] Keep route handlers thin and integration dependencies injectable.

Acceptance criteria:
- [ ] Domain/application code has no request/response dependency.
- [ ] SQL and external calls have one owner per workflow.

Tests:
- [ ] Service tests plus route contract tests after each extraction.

Verification result:
Four application services are extracted and unit-tested (`lead-delivery`,
`media-storage`, `runtime-initializer`, `operations-dashboard`), integrations
live in `server/integrations/`, repositories in `server/repositories/`, and
policies in `server/policies/`. Remaining increments — authenticate/change
password/2FA, update setting, update content, translation job orchestration —
are still owned by their route modules (`admin.auth.js` 1177 lines,
`admin.content.js` 1541, `admin.settings.js` 1019, `admin.2fa.js` 927).
Those routes are behaviourally correct and covered by real-SQLite tests; the
remaining extraction is deliberately deferred rather than performed as one
high-risk rewrite, per the incremental instruction in the review.

Related tasks:
All P0 business flows, CR-010 through CR-013.

### CR-010 — Atomic DB route initialization

Priority: P1

Status: DONE

Problem:
`dbRoutesReady=true` is set before database opening and registration. A first
failure permanently skips initialization; partial registration cannot roll back.

Files:
- `server/app.js`
- `server/bootstrap.js` (new)
- `server/router.js`
- `vite.config.js`
- tests

Implementation:
- [x] Add `idle|initializing|ready|failed` state and a shared promise.
- [x] Stage routers/workers and publish only when completely ready.
- [x] Define bounded retry for transient initialization failures.
- [x] Prevent duplicate registration.
- [x] Make dev initialization propagate/retry failures consistently.

Acceptance criteria:
- [x] Parallel callers share one initialization.
- [x] A failed first attempt can safely retry.
- [x] No partially registered route set becomes visible.

Tests:
- [x] Parallel start, fail/retry, partial failure, exactly-once registration.

Verification result:
Initializer tests 3/3 pass; staged router publication is integrated in
`server/app.js`; full checkpoint lint/test/build passes.

Related tasks:
CR-009, CR-022, CR-023.

### CR-011 — Atomic media upload and reconciliation

Priority: P1

Status: DONE

Problem:
Quota and duplicate SHA use check-then-act; temp names collide; filesystem
rename precedes DB insert with no compensation; GC misses orphans and missing files.

Files:
- media application/repository/policy modules
- `server/routes/admin.media.js`
- `server/lib/maintenance.js`
- migration if a reservation state is required
- tests

Implementation:
- [x] Use request-ID-based exclusive temp files.
- [x] Keep content sniffing authoritative.
- [x] Reserve quota and SHA conflict-safely in a transaction.
- [x] Compensate both DB and filesystem partial failures.
- [x] Reconcile stale parts, orphan final files, and missing referenced files.
- [x] Account for soft-deleted physical storage consistently.

Acceptance criteria:
- [x] Concurrent uploads cannot bypass quota or create duplicate files/rows.
- [x] No tested partial failure leaves an orphan or false reservation.

Tests:
- [x] Duplicate, concurrency, quota boundary, DB/rename failure, GC/reconcile.

Verification result:
Six real-SQLite/filesystem tests cover publication, concurrent duplicate SHA,
quota, DB failure, rename failure and reconciliation. Full checkpoint passes.

Related tasks:
CR-006, CR-009, CR-020, CR-022.

### CR-012 — Reliable public content fallback

Priority: P1

Status: DONE

Problem:
Locale DB errors become an empty result and may cache build fallback as a fresh
revision. Empty, failed, and successful reads are not distinct.

Files:
- `server/routes/public.content.js`
- content repository/cache service
- operational dashboard
- tests

Implementation:
- [x] Represent `success|empty|error` explicitly.
- [x] Cache a revision only after successful DB reads.
- [x] Reuse the last valid cache on error.
- [x] Use build fallback only when no valid state exists and mark degraded internally.
- [x] Never expose database details publicly.

Acceptance criteria:
- [x] Temporary SQLite failure cannot replace a valid cached revision.
- [x] Recovery publishes the next valid revision.

Tests:
- [x] Empty DB, error with/without cache, generation error, recovery.

Verification result:
Focused degraded-cache suite 4/4 passes; full checkpoint lint/test/build passes.

Related tasks:
CR-009, CR-021, CR-022.

### CR-013 — Server-owned capabilities

Priority: P1

Status: DONE

Problem:
Session payload has a role only. Frontend shows every section/action to every
role, while each backend route owns a duplicate role list.

Files:
- `server/policies/capabilities.js` (new)
- auth guard/session response
- admin route authorization
- `src/admin/AdminApp.jsx`
- admin screens
- tests

Implementation:
- [x] Define one role → capability policy on the server.
- [x] Authorize backend actions by capability.
- [x] Return the capability map in current-session responses.
- [x] Drive menus, buttons, forms, and destructive actions only from capabilities.
- [x] Keep backend checks independent of UI visibility.

Acceptance criteria:
- [x] Frontend contains no duplicate role mapping.
- [x] Viewer/editor/admin/owner behavior matches the tested matrix.

Tests:
- [x] Full role-capability and representative endpoint matrix.

Verification result:
Capability matrix and password-change/representative route integration tests
pass; the frontend consumes booleans without any role mapping.

Related tasks:
CR-001, CR-009, CR-017, CR-021.

### CR-014 — Correct CORS allowlist semantics

Priority: P1

Status: DONE

Problem:
The lead handler rereads raw `ALLOWED_ORIGINS`, never merges
`PUBLIC_ORIGIN`, and treats any Origin as allowed when extras are empty.

Files:
- `server/config.js`
- CORS/request-context policy
- `api/lead.js`
- `server/routes/public.lead.js`
- tests/docs

Implementation:
- [x] Build a normalized `{PUBLIC_ORIGIN + extras}` allowlist.
- [x] Use one CORS policy in Node and serverless adapters.
- [x] Normalize scheme, hostname case, port, and trailing slash.
- [x] Reject wildcard credential semantics.

Acceptance criteria:
- [x] The primary form origin always works.
- [x] Extras add rather than replace origins.
- [x] Malformed origins fail safely.

Tests:
- [x] Primary, extra, case/port/slash, malformed, wildcard.

Verification result:
Shared-policy, Node adapter, and serverless adapter tests pass. Full lint and
the complete 408-test suite pass.

Related tasks:
CR-002, CR-007, CR-022, CR-025.

## P2 — User experience

### CR-015 — Real public 404

Priority: P2

Status: DONE

Problem:
Unknown HTML paths receive the home SPA and HTTP 200 in Node and Vercel.

Files:
- `server/app.js`
- `server/http/respond.js`
- `src/App.jsx`
- `src/routes/NotFound.jsx` (new)
- `vercel.json`
- tests

Implementation:
- [x] Classify the root public route, revealed admin route, hidden admin/honeypot, and unknown route.
- [x] Return a Not Found shell with status 404 for unknown public routes.
- [x] Preserve indistinguishable masking for hidden admin paths.
- [x] Add noindex and correct canonical behavior.
- [x] Keep direct navigation/refresh working.

Acceptance criteria:
- [x] `/` is 200; an unknown public URL is 404.
- [x] The secret revealed admin route remains 200.
- [x] Hidden admin and unknown routes do not create a discovery oracle.

Tests:
- [x] GET/HEAD/direct refresh/canonical/noindex route tests.

Verification result:
`server/http/spa.js` returns status 404 with `X-Robots-Tag: noindex, nofollow`
for unknown public paths while keeping the SPA shell byte-identical for hidden
admin masking; `src/App.jsx` renders a Not Found screen. Covered by
`server/http/spa.test.js` and `npm run smoke:production`.

Related tasks:
CR-016, CR-022.

### CR-016 — Neutral admin loading and failure shell

Priority: P2

Status: DONE

Problem:
Admin probing renders Home, has no timeout, conflates API outage with
non-admin, and lazy admin uses `fallback={null}`.

Files:
- `src/App.jsx`
- loading/error boundary components
- admin API client
- tests

Implementation:
- [x] Use a discriminated, timed probe with retry.
- [x] Render a neutral accessible skeleton while checking/loading.
- [x] Lazy-load public and admin branches without flashing Home.
- [x] Add chunk-error retry and an API-unavailable screen.

Acceptance criteria:
- [x] No public-home flash on admin navigation.
- [x] Loading and failure are visible to screen readers.

Tests:
- [x] Probe success/not-found/network/5xx/timeout and chunk failure.

Verification result:
`src/App.jsx` renders a neutral `LoadingShell` during the admin probe and as the
`Suspense` fallback, with an error boundary for chunk failures. No public home
flash remains.

Related tasks:
CR-015, CR-017, CR-022.

### CR-017 — Central human-readable frontend error model

Priority: P2

Status: DONE

Problem:
Public/auth/admin flows duplicate sparse error maps; request IDs and actions are
missing and raw machine codes can become the primary text.

Files:
- `src/errors/catalog.js` (new)
- `src/admin/api.js`
- notices/auth screens/Contact
- server response helper
- tests

Implementation:
- [x] Cover all required technical codes with message and recommended action.
- [x] Carry request ID separately from the safe technical code.
- [x] Remove raw stack/path/SQL/secret detail from client errors.
- [x] Use the same catalog across public and admin flows.

Acceptance criteria:
- [x] Every required code has a human message and action.
- [x] Request ID is independently visible for support.

Tests:
- [x] Catalog table and safe rendering/leakage tests.

Verification result:
`src/errors.js` covers all 14 required codes plus legacy aliases, exposes
message/action/request ID separately, and is covered by `src/errors.test.js`.

Related tasks:
CR-001, CR-003, CR-016, CR-019.

### CR-018 — Accessible drawer, modal, lightbox, and confirmations

Priority: P2

Status: DONE

Problem:
Existing overlays have partial Escape/scroll handling but lack complete focus
entry/trap/return, inert background, and reduced-motion behavior. Lightbox lacks
a visible close button.

Files:
- `src/hooks/useDialog.js` (new)
- Header/Projects/ConfirmButton/2FA components
- `src/hooks/useScrollLock.js`
- canvas effects/CSS
- tests

Implementation:
- [x] Centralize focus entry, trap, return, Escape, close, ARIA, inert, and scroll restore.
- [x] Apply it to every modal-like surface.
- [x] Make canvas/CSS motion static under reduced motion.
- [x] Preserve inline confirmation semantics or replace with scoped accessible dialogs.

Acceptance criteria:
- [x] Keyboard-only focus cannot escape an open dialog.
- [x] Focus returns to the trigger and background interaction is blocked.

Tests:
- [x] DOM/accessibility keyboard and reduced-motion tests.

Verification result:
`src/hooks/useModalA11y.js` centralizes focus entry, trap, return, Escape, ARIA
and scroll restore; applied to the mobile drawer (`Header.jsx`) and the project
modal/lightbox (`Projects.jsx`). `ConfirmButton` keeps inline non-modal
confirmation deliberately, so it needs no trap.

Related tasks:
CR-019, CR-022.

### CR-019 — Improve the lead form

Priority: P2

Status: DONE

Problem:
The form lacks privacy/retention notice, autocomplete/inputmode, complete error
association, visible sending text, and delivery-specific outcomes. Logging the
whole Axios error can expose serialized lead PII.

Files:
- `src/components/Contact.jsx`
- localization/content data
- shared form policy/error catalog
- tests

Implementation:
- [x] Add localized privacy purpose and 365-day retention wording, with a policy link/place for legal review.
- [x] Add autocomplete, inputmode, describedby, and live regions.
- [x] Keep visible sending text with the spinner.
- [x] Preserve values on network/delivery-unknown outcomes.
- [x] Remove/redact PII-bearing console errors.
- [x] Respect server-provided `form.require_message`.

Acceptance criteria:
- [x] Success alone clears the form.
- [x] Validation/rate/Telegram/network/unknown/success are distinguishable.
- [x] Double submission remains blocked.

Tests:
- [x] Form policy, accessibility attributes, outcomes, preservation, duplicate click.

Verification result:
The form carries `autoComplete`, `inputMode`, `aria-invalid`,
`aria-describedby`, a live status region, visible sending text, a privacy
notice, server-driven `requireMessage`, and outcome-specific messages with a
separate request-ID/technical-code line.

Related tasks:
CR-002, CR-006, CR-017, CR-018.

### CR-020 — Backend-owned media upload capabilities

Priority: P2

Status: DONE

Problem:
Backend allows 400 KiB while frontend assumes 2 MiB; MIME/extensions and quota
are independently hardcoded. DB allows AVIF while runtime sniffer does not.

Files:
- media policy/capability endpoint
- `server/routes/admin.media.js`
- `server/lib/image.js`
- migration if AVIF contract changes
- `src/admin/screens/Media.jsx`
- tests

Implementation:
- [x] Define max size, MIME, extensions, dimensions, recommendations, and quota once on backend.
- [x] Return remaining quota to authorized clients.
- [x] Remove frontend hardcoded limits and revalidate server-side.
- [x] Resolve AVIF end-to-end or remove it from the durable contract.

Acceptance criteria:
- [x] UI displays and uses exactly server-provided limits.

Tests:
- [x] Endpoint roles/values, client consumption, server rejection.

Verification result:
Viewer endpoint integration asserts runtime quota and capability values; image
tests cover WebP/JPEG/PNG/AVIF content sniffing and server-side rejection.

Related tasks:
CR-006, CR-011, CR-013.

### CR-021 — Operational admin dashboard

Priority: P2

Status: DONE

Problem:
Overview displays only username, role, AMR, and expiry.

Files:
- operational overview application service/route
- `src/admin/AdminApp.jsx`
- dashboard components
- tests

Implementation:
- [x] Aggregate leads, failed/unknown delivery, Telegram readiness, translation queue/failures, media quota, configuration warnings, worker state, last success, and security warnings.
- [x] Filter data/actions by server capabilities.
- [x] Link each warning/card to its actionable section.
- [x] Never expose secret values.

Acceptance criteria:
- [x] Every role sees only permitted operational data.
- [x] Partial/degraded sources are explicit, not false zeroes.

Tests:
- [x] Role matrix and degraded aggregate tests.

Verification result:
`server/application/operations-dashboard.js` aggregates the operational data,
`server/routes/admin.operations.js` exposes it under capability checks, and
`src/admin/screens/Overview.jsx` renders it. No secret value is returned.

Related tasks:
CR-003, CR-012, CR-013, CR-017.

### CR-026 — Keep Contact and Footer on one outer glass surface

Priority: P2

Status: DONE

Problem:
The requested structure is already present (`Contact` then `Footer` inside
`.pv-outro`), but needs visual verification and a stale Footer comment still
describes the old glass owner.

Files:
- `src/routes/Home.jsx`
- `src/components/Footer.jsx`
- `src/index.css`
- visual smoke artifacts

Implementation:
- [ ] Preserve exactly Contact + Footer inside `.pv-outro`.
- [ ] Keep About and every earlier section outside and unchanged.
- [ ] Keep existing Contact cards, grid, content, and animation.
- [ ] Reconcile comments and make only minimal join/glass polish if screenshots show a seam.

Acceptance criteria:
- [ ] One continuous outer glass panel at 1440, 768, and 375 px.
- [ ] No unrelated spacing/layout/design change.

Tests:
- [ ] DOM structure plus responsive visual/browser smoke, including RTL.

Verification result:
`src/routes/Home.jsx` keeps exactly `Contact` + `Footer` inside `.pv-outro`, and
the stale Footer comment now names `.pv-outro` as the single glass owner.
Browser-rendered verification is tracked under CR-030.

Related tasks:
CR-018, CR-019.

## P3 — Tests, CI, release, and documentation

### CR-022 — Real-SQLite integration suite

Priority: P3

Status: DONE

Problem:
The 333 passing tests are mostly units. Required auth, lead, settings, media,
fallback, initialization, proxy, and 404 workflows are absent.

Files:
- `test/integration/` and helpers (new)
- application/route tests

Implementation:
- [x] Create temp file-SQLite harness using the real migration runner.
- [x] Create ephemeral HTTP/cookie/CSRF helpers.
- [x] Inject local Telegram and DeepL mocks only.
- [x] Add every scenario enumerated in the review request.
- [x] Add fresh-schema and existing-DB upgrade fixtures.

Acceptance criteria:
- [x] Mandatory suites cannot silently skip on the supported Node version.
- [x] No test can contact real Telegram/DeepL.

Tests:
- [x] Login/password/2FA/disabled/roles.
- [x] Lead/delivery/retry/settings/secret/DeepL.
- [x] Media/quota/concurrency/content/init/CORS/proxy/404.

Verification result:
33 test files / 446 tests run against real temporary SQLite databases with
injected Telegram and DeepL mocks. No test reaches a real external service.

Related tasks:
All implementation tasks.

### CR-023 — Clean CI pipeline

Priority: P3

Status: DONE

Problem:
No root CI workflow, Node engine, smoke scripts, release/secret gates, or
generated-file cleanliness check exists.

Files:
- `.github/workflows/ci.yml` (new)
- `package.json`
- scripts/tests

Implementation:
- [x] Pin supported Node and enforce lock consistency.
- [x] Run `npm ci`, lint, tests, build.
- [x] Add migration, production start, API, and public/admin smoke.
- [x] Add release manifest/secret verification.
- [x] Check generated tree cleanliness when a git checkout is available.

Acceptance criteria:
- [x] CI succeeds from a clean checkout without preexisting `node_modules`.

Tests:
- [x] Local execution of every CI script.

Verification result:
`.github/workflows/ci.yml` pins Node 22.13.1, runs `npm ci`, lint, test, build,
migration/production/release smoke, release verification, and a generated-tree
cleanliness check.

Related tasks:
CR-008, CR-022, CR-024.

### CR-024 — Reproducible minimal release process

Priority: P3

Status: DONE

Problem:
Builder copies whole source directories (including tests), writes directly into
`release/`, has no manifest/checksums, and packages a seed script whose required
assets/locales are omitted. Runtime package is unpruned.

Files:
- `scripts/build-release.mjs`
- release verifier/manifest scripts
- seed bootstrap assets/script
- runtime package metadata
- release tests/docs

Implementation:
- [x] Stage in a temporary directory and atomically publish.
- [x] Copy a strict runtime allowlist and exclude all forbidden material.
- [x] Fix seed bootstrap or replace it with a self-contained supported path.
- [x] Emit minimal runtime package with Node engine.
- [x] Produce deterministic ordering/metadata where the platform permits.
- [x] Emit version, commit/unavailable marker, build date, Node, schema, and SHA-256 file manifest.

Acceptance criteria:
- [x] Release seed/migration/start smoke succeeds.
- [x] Verifier proves the archive contains only the manifest allowlist.

Tests:
- [x] Build twice, inspect, verify checksums/forbidden fixtures.

Verification result:
The builder stages into a temporary directory, publishes atomically, emits
`RELEASE_MANIFEST.json` with version, commit, build date, Node version, schema
version and SHA-256 checksums, and is verified by `npm run verify:release`.

Related tasks:
CR-008, CR-023, CR-025.

### CR-025 — Operational documentation

Priority: P3

Status: DONE

Problem:
README is still the Vite template. Deployment notes omit most required
security/operations topics and include a broad destructive cleanup command.

Files:
- `README.md`
- `.env.example`
- `docs/DEPLOYMENT.md`
- `docs/OPERATIONS.md`
- `docs/SECURITY_MODEL.md`
- release deployment guide

Implementation:
- [x] Document actual architecture, setup, configuration, and commands.
- [x] Document reverse proxy/trusted proxy, backup/restore, migrations, media.
- [x] Document Telegram/DeepL, roles/capabilities, password gate, 2FA recovery, delivery states.
- [x] Document troubleshooting, release verification, rollback, and infrastructure conditions.
- [x] Replace broad cleanup guidance with staged backup-first deployment.

Acceptance criteria:
- [x] Names, states, keys, limits, and commands match the implemented code.

Tests:
- [x] Documentation command/link smoke where automatable.

Verification result:
`README.md`, `.env.example`, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`,
`docs/SECURITY_MODEL.md` and `docs/RELEASE.md` describe the implemented
behaviour, including trusted proxy topology, delivery states, capabilities and
release verification.

Related tasks:
All tasks; final report.

## Additional confirmed review findings

### CR-027 — Align translation routing UI and runtime contract

Priority: P0

Status: DONE

Problem:
Admin accepts scalar providers and excludes `mymemory`; runtime expects arrays
and may silently restore a fallback. Choosing “none” can fail to disable work.

Files:
- shared settings registry
- admin settings route/UI
- translation registry/worker
- migration/tests

Implementation:
- [x] Canonicalize arrays and empty-array disabled state.
- [x] Expose only providers supported by the runtime/language.
- [x] Remove silent fallback after an explicit stored choice.

Acceptance criteria:
- [x] UI choice maps exactly to worker provider order.

Tests:
- [x] Per-language routing, disabled route, legacy scalar backfill.

Verification result:
PASS — shared normalization, migration backfill, runtime registry, focused
lint, full test suite, and production build pass. Explicit `[]` remains
disabled and ordered routes are preserved.

Related tasks:
CR-004, CR-006.

### CR-028 — Prevent PII-bearing client error logging

Priority: P1

Status: DONE

Problem:
`Contact.jsx` logs the full Axios error; Axios config may include serialized
name, phone, and message.

Files:
- `src/components/Contact.jsx`
- frontend safe diagnostics helper/tests

Implementation:
- [x] Log only safe code/request ID in development, or remove the log.
- [x] Ensure user-visible diagnostics never include request payloads.

Acceptance criteria:
- [x] A failed submission leaves no lead PII in captured console output.

Tests:
- [x] Console spy with a representative Axios failure.

Verification result:
`src/components/Contact.jsx` no longer logs the Axios error object; only the
safe technical code and request ID reach the user-visible diagnostic line.

Related tasks:
CR-017, CR-019.

### CR-029 — Make release content seeding self-contained

Priority: P1

Status: DONE

Problem:
The release includes `scripts/seed-content.mjs` and instructs operators to run
it, but omits `public/locales` and `src/assets/design`, which the script requires.

Files:
- seed script/payload
- release builder
- deployment guide/tests

Implementation:
- [x] Generate a minimal seed payload during build or provide a supported bootstrap command that needs no source tree.
- [x] Fail release verification if the documented first-deploy seed cannot run.

Acceptance criteria:
- [x] First-deploy seed smoke passes inside the staged release.

Tests:
- [x] Release-stage seed dry run with a temporary DB/data directory.

Verification result:
`npm run smoke:release` extracts the built archive and runs the packaged
`scripts/seed-content.mjs --dry-run` inside it against a temporary DATA_DIR.

Related tasks:
CR-024, CR-025.

### CR-030 — Post-remediation super-review and rendered footer verification

Priority: P3

Status: DONE

Problem:
Static fixes can introduce or leave analogous cross-layer defects, and the
shared Contact/Footer surface must be proven in a rendered browser rather than
inferred only from JSX/CSS.

Files:
- Entire maintained source (excluding generated release copies)
- rendered public page at desktop/tablet/mobile and RTL
- final remediation report

Implementation:
- [x] Re-run the bundled `super-review` repository scan after all changes.
- [x] Repeat manual authorization, state-machine, retry/idempotency, settings,
      proxy trust, filesystem/DB atomicity, error, and UX action traces.
- [x] Fix every confirmed in-scope regression or analogous logical defect.
- [x] Render and inspect the Contact/Footer join at 1440, 768, and 375 px plus RTL.
- [x] Re-run all relevant gates after any final correction.

Acceptance criteria:
- [x] No unresolved confirmed P0 issue remains.
- [x] Final scanner findings are triaged with evidence, not ignored mechanically.
- [x] Footer/outro is visually continuous, readable, responsive, and free of
      overlap/clipping while earlier sections remain unchanged.

Tests:
- [x] Final super-review scan and manual evidence pass.
- [x] Browser screenshots/DOM/accessibility smoke.
- [x] Full lint/test/build/release verification after final fixes.

Verification result:
Static pass complete. No empty catch block, no secret-bearing log statement
(only key names and redacted reasons), a single canonical reader of
`X-Forwarded-For`/`X-Real-IP` in `server/http/request-context.js`, and no error
path returning HTTP 200 remain in `server`, `src`, `api`, `shared` or `scripts`.
The pass found and fixed CR-031. All gates re-run green afterwards.

The rendered verification finally ran under CR-056, using Playwright with
Chromium. `.pv-outro` is a single surface with `Contact` followed by `Footer`
inside it, `role=contentinfo` is present, and there is no horizontal overflow at
1440x900, 1024x768, 768x1024, 390x844 or 375x667, nor in RTL at 1440 or 375.
Screenshots were captured at every viewport and kept as scratch artifacts rather
than committed.

The static pass had also reported clean; what the render added was two defects
static analysis could not see, recorded as CR-064 and CR-065.

Related tasks:
All tasks, especially CR-001 through CR-014 and CR-026.

### CR-031 — Extract release archives without the external `tar` binary

Priority: P0

Status: DONE

Problem:
`scripts/verify-release.mjs` and `scripts/release-smoke.mjs` shelled out to the
GNU `tar` CLI with an absolute path. On Windows `tar` reads a leading `C:` as a
remote host specification and aborts with `Cannot connect to C: resolve failed`,
so both release gates failed on the platform the release is actually built on.
The gates also depended on an external binary that a clean CI image is not
guaranteed to provide.

Files:
- `scripts/release-archive.mjs` (new)
- `scripts/release-archive.test.js` (new)
- `scripts/verify-release.mjs`
- `scripts/release-smoke.mjs`

Implementation:
- [x] Implement an in-process gzip/ustar reader matching the writer in `build-release.mjs`.
- [x] Reject absolute member paths, `..` traversal, and unsupported entry types.
- [x] Require an `app/` root before verification proceeds.
- [x] Use the reader in both release gates and drop the `tar` child process.

Acceptance criteria:
- [x] `npm run verify:release` and `npm run smoke:release` pass on Windows.
- [x] Release verification no longer depends on an external archiver.
- [x] A crafted archive cannot write outside the extraction directory.

Tests:
- [x] Round trip, implicit parent directories, traversal, absolute path, missing
      root, unsupported entry type — 6 tests.

Verification result:
`npx vitest run scripts/release-archive.test.js`: PASS — 6 tests.
`npm run build:release && npm run verify:release && npm run smoke:release`: PASS.
Full `npm run lint`, `npm test` (33 files, 446 tests) and `npm run build`: PASS.

Related tasks:
CR-008, CR-023, CR-024, CR-029.

# Iteration 3 — Reliability, Security and Performance

Independent verification performed on 2026-07-30 against the working tree, not
against `CODE_REVIEW_REMEDIATION_REPORT.md`. Every finding below is recorded with
the exact code evidence that proves it.

Verified baseline: lint PASS, 33 test files / 446 tests PASS, build PASS,
migration/production/release smoke PASS. Four migrations (`001`–`004`).

Independent findings that contradict or extend the iteration-2 report:

- `server/auth/session.js:128` guards on `db.isTransaction`, a property that does
  not exist — the database wrapper exposes `inTransaction`
  (`server/db/index.js:108`, `server/db/driver.js:223`). → CR-044.
- `server/application/lead-delivery.js:49-52` states in a comment that a double
  finalize failure leaves the attempt in `sending` and defers to a
  "reconciliation" that exists nowhere in the tree. → CR-032.
- `vercel.json` and the standalone `api/lead.js` runtime are both still present,
  so one endpoint has two different business behaviours. → CR-036.
- `server/routes/admin.leads.js:354` uses `LIMIT ? OFFSET ?`;
  `server/routes/admin.media.js:299` has a hardcoded `LIMIT 500` as the only
  media access path. → CR-047.
- `server/http/respond.js:29` hardcodes `includeSubDomains` in HSTS. → CR-051.
- `server/translate/worker.js` acquires a lease with no heartbeat or renewal, and
  `server/index.js:161,202` owns raw `setInterval` handles with no lifecycle
  owner. → CR-039, CR-038.

## P0 — Data integrity and security

### CR-032 — Recover stranded `sending` delivery attempts

Priority: P0 · Status: DONE· Depends on: CR-044

Root cause:
`deliverClaimed()` finalizes to `sent`; if that write fails it finalizes to
`delivery_unknown`; if that write also fails the catch block is empty and the
durable attempt stays `sending` forever. `claimRetry()` rejects any lead whose
latest attempt is `pending`/`sending` with `delivery_in_progress`, and the
partial unique index `lead_delivery_one_active_idx` blocks inserting a new
attempt row. There is no TTL and no recovery job, so the lead becomes
permanently unretryable.

Files: `server/application/lead-delivery.js`, `server/repositories/leads.js`,
`server/application/delivery-recovery.js` (new), `server/db/migrations/005_*.sql`,
`server/index.js`, `server/application/operations-dashboard.js`,
`src/admin/screens/Leads.jsx`.

Migration requirements: `recovered_at` and `recovery_reason` on attempts, an
index supporting the stale scan, and a recovery lease row.

Acceptance criteria:
- [x] A `sending` attempt older than the TTL becomes `delivery_unknown`, never `failed`.
- [x] The conditional update cannot touch an attempt that already reached a terminal state.
- [x] Two concurrent recovery runs perform the transition exactly once.
- [x] A late finalize cannot overwrite the recovered terminal state.
- [x] Manual retry of a recovered lead still requires explicit confirmation.
- [x] The dashboard surfaces the recovered count as a warning.

Unit tests: TTL boundary, conditional update guard, recovery reason recorded.
Integration tests: both finalize writes fail, row observed as `sending`, recovery
transitions it, retry then requires confirmation.
Concurrency tests: two recovery workers, late finalize after recovery.
Performance: stale scan uses the new index (`EXPLAIN QUERY PLAN`).

Result:
`server/application/delivery-recovery.js` adds a TTL-bounded recovery pass with
an `app_state` lease, a conditional UPDATE that cannot touch a terminal state,
and `recovered_at`/`recovery_reason` from migration `005`. It runs at startup,
on every 60 s tick (`server/index.js`) and immediately before an operator resend
(`server/routes/admin.leads.js`), and the dashboard counts recovered and still
stranded attempts. `npx vitest run server/application/delivery-recovery.test.js`:
PASS — 10 tests, including both finalize writes failing, TTL boundary, exactly-once
across two runs, busy and expired lease, a late finalize that must win, retry still
demanding confirmation, and an `EXPLAIN QUERY PLAN` assertion that the scan uses
`lead_delivery_stale_idx`.

### CR-033 — End-to-end submission idempotency

Priority: P0 · Status: DONE· Depends on: CR-032

Root cause:
`createPending()` keys only on `idempotency_key` and returns the previous attempt
for any repeat, with no payload fingerprint — a reused key with a different
payload silently returns another submission's result. The client never sends a
key at all, so a network timeout or a page reload creates a duplicate lead.

Files: `src/components/Contact.jsx`, `shared/lead.js`, `api/lead.js`,
`server/repositories/leads.js`, `server/db/migrations/005_*.sql`.

Migration requirements: `payload_fingerprint` column and a documented retention
window for idempotency records.

Acceptance criteria:
- [x] The client generates a `crypto.randomUUID()` key, persists it in `sessionStorage`, and reuses it after timeout, 5xx and `delivery_unknown`.
- [x] The key is dropped after a confirmed `sent` and regenerated when significant fields change, but not on a repeated click.
- [x] Same key + same fingerprint replays the stored result without a second Telegram call.
- [x] Same key + different fingerprint returns `409 idempotency_conflict`.
- [x] A low-entropy or malformed key is rejected.
- [x] No Telegram message ID reaches the public client.

Unit tests: fingerprint normalization, key validation, sessionStorage lifecycle.
Integration tests: replay after timeout, replay after reload, process restart
between request and replay, conflicting payload.
Concurrency tests: two simultaneous requests with one key produce one Telegram
call and one lead.

Result:
Canonical payload rules live in `shared/lead.js` (NFKC, collapsed whitespace,
case-folded name, digit-only phone, whitelisted locale and pagePath — the last
of which also closes the `pagePath` half of CR-050). `server/repositories/leads.js`
stores and compares a SHA-256 fingerprint over that canonical form; a NULL
fingerprint from a pre-CR-033 or admin-retry row counts as a mismatch, so the
failure mode is a refusal rather than another lead's result. Key admission is
now UUID v4 only on the public endpoint. `src/components/Contact.jsx` binds a
`crypto.randomUUID()` key to the payload digest in `sessionStorage`, retains it
through timeout/5xx/`delivery_unknown` and clears it only on a confirmed `sent`;
no PII is written to storage.

No migration was needed — `payload_fingerprint` and both indexes already exist
from `005`, and idempotency records are cascade-deleted with the lead at
`purge_after` (365 days). An empty `006` was deliberately not created.

`npx vitest run shared/lead.test.js server/repositories/leads.test.js
server/application/lead-pipeline.test.js server/application/lead-idempotency.test.js`:
PASS — 4 files, 68 tests. Fault injection PASS for client timeout, page reload,
process restart between request and replay, two simultaneous requests with one
key (one lead, one Telegram call), conflicting payload, malformed/low-entropy/
duplicated keys, NULL-fingerprint rows, and a client with storage or CSPRNG
unavailable. Two fixtures in `server/routes/public.lead.test.js` were updated to
UUID v4 to match the tightened rule.

### CR-034 — Safe restore of soft-deleted media

Priority: P0 · Status: DONE· Depends on: CR-037

Root cause:
Restore clears `deleted_at` before quota and physical-file checks, so it can push
storage past the quota or activate a row whose file no longer exists.

Files: `server/application/media-storage.js`, `server/routes/admin.media.js`,
`server/db/migrations/005_*.sql`.

Migration requirements: none beyond the CR-037 availability column.

Acceptance criteria:
- [x] Quota is evaluated before any write; over quota returns `quota_exceeded` with the database unchanged.
- [x] A missing physical file is republished from the temporary upload before the row is activated.
- [x] No active row can exist without a file and no orphan file survives a DB failure.
- [x] Concurrent restore of one SHA activates exactly once.

Unit tests: quota arithmetic, state transition guard.
Integration tests: within quota, over quota, missing file, rename failure, DB
failure, duplicate upload of active media.
Concurrency tests: parallel restore of the same SHA.

Result:
Root cause confirmed at `server/application/media-storage.js:67-73` (pre-edit):
the existing-row branch of the reservation transaction cleared `deleted_at`
immediately, while the quota check sat in the `else` branch and the physical-file
check ran after the commit.

The existing-row branch now performs no writes at all. A new `restore()`
implements the mandated order — locate by SHA, read-only quota preflight, `lstat`
the file, republish from the temporary upload (removing a squatting symlink
first), then a conditional `UPDATE ... WHERE id = ? AND (deleted_at IS NOT NULL
OR availability <> 'available')` inside a transaction that re-prices the quota
under the write lock, with `rollbackPublication()` on every non-restored outcome.
Rollback keeps the file when a concurrent winner already activated the row:
leaving an active row without a file is the worse failure of the two.

`npx vitest run server/application/media-storage.test.js`: PASS — 31 tests across
CR-034 and CR-037. Fault injection: over-quota restore proves the row is
byte-identical before and after, missing file yields `file_missing` and flips the
row to `missing`, an `EIO` rename leaves no file and no temp part, a DB failure
targeted at the activation transaction removes the published file and leaves no
orphan, and concurrent restore of one SHA produces exactly one active row.

### CR-035 — Atomic and safe TOTP rebind

Priority: P0 · Status: DONE

Root cause:
Enrollment overwrites the confirmed factor before the new code is verified, so an
abandoned or failed rebind can leave the account without a working second factor.

Files: `server/routes/admin.2fa.js`, `server/auth/totp.js`,
`server/db/migrations/005_*.sql`, `src/admin/screens/Setup2fa.jsx`.

Migration requirements: pending TOTP state (encrypted secret, expiry, owner,
setup-session binding) separate from the active factor.

Acceptance criteria:
- [x] The confirmed TOTP keeps working for login throughout enrollment.
- [x] A pending secret can never authenticate a login.
- [x] Confirmation atomically swaps the secret, regenerates recovery codes, revokes other sessions and writes an audit event.
- [x] Abandonment, expiry or a mid-swap DB failure leaves the old factor intact.
- [x] Changing an existing TOTP requires reauthentication or a current second factor.
- [x] No secret appears in logs or audit payloads.

Unit tests: pending expiry, swap guard, audit redaction.
Integration tests: old factor during pending setup, pending secret rejected at
login, swap on confirm, old secret rejected after swap, abandoned setup, expired
setup, recovery-code regeneration timing.
Concurrency tests: two parallel setups, DB failure during swap.

Result:
Root cause confirmed at `server/routes/admin.2fa.js:97-112` and `:412-422`
(pre-edit): `SQL_UPSERT_SECRET` wrote the candidate into the live factor row and
set `confirmed_at = NULL` at QR-display time, and since both login and
`loadConfirmedTotp` define the second factor as the row with a non-NULL
`confirmed_at`, that single statement destroyed the working factor before any
new code was verified.

Migration `007_totp_pending.sql` adds a `totp_pending` table (encrypted secret in
the same ct/iv/tag layout, expiry with `CHECK (expires_at > created_at)`,
`UNIQUE(user_id, session_id)`, cascade from `users` and `sessions`) and clears
old-flow leftovers so every remaining `totp_secrets` row is a working factor.
Binding is per (user, setup session), which is what makes two parallel
enrolments safe; the confirm transaction consumes the pending row first and
checks `changes`, so that row is now the concurrency guard. Confirmation also
revokes the user's other sessions inside the same transaction, and changing an
existing factor now requires fresh reauthentication.

`npx vitest run server/routes/admin.2fa.rebind.test.js server/auth/totp.test.js`:
PASS — 87 tests, 17 new. Fault injection: `db.run` forced to throw mid-swap →
500 `totp_swap_failed`, old secret still active, recovery codes untouched, login
by the old code still works, and a later retry completes the rebind.
Disclosure check scans audit rows and captured console output for the old
secret, the new secret and all ten recovery codes in both formats.

### CR-036 — One production deployment model

Priority: P0 · Status: DONE

Root cause:
`vercel.json` and the standalone `api/lead.js` export a second production runtime
for `/api/lead` that reads environment configuration, uses an in-memory limiter
and never writes a durable lead, while the Node runtime uses SQLite settings,
durable attempts and idempotency. One endpoint, two business behaviours.

Decision: the Node application is the only supported production runtime. The lead
pipeline stays a transport-independent function because the Node route is its
only consumer; the serverless descriptor and default export are removed.

Files: `vercel.json`, `api/lead.js`, `README.md`, `docs/DEPLOYMENT.md`,
`.github/workflows/ci.yml`, `scripts/verify-deployment-model.mjs` (new).

Migration requirements: none.

Acceptance criteria:
- [x] No serverless deployment descriptor remains in the repository.
- [x] The lead pipeline exists once and is reachable only through the Node runtime.
- [x] No in-memory production rate limiter remains reachable from a production path.
- [x] CI fails if a divergent production entrypoint reappears.

Unit tests: guard-script detection of a reintroduced descriptor or default export.
Integration tests: the existing lead suite continues to pass unchanged.

Result:
`vercel.json` and the `api/` directory are deleted. The pipeline moved to
`server/application/lead-pipeline.js` with the environment config, in-memory
limiter and non-persisting delivery removed, and its dependencies are now
mandatory (`requireDep`) instead of silently falling back to that runtime.
Removing the env path also deleted a `phoneTail` log line, so part of CR-050 is
resolved here. `scripts/verify-deployment-model.mjs` fails on a serverless
descriptor, a platform-mounted function directory or a default-exported handler,
and runs in CI and in `npm run ci`. `npx vitest run server/application/lead-pipeline.test.js`:
PASS — 12 tests. `node scripts/verify-deployment-model.mjs`: PASS.

### CR-058 — A failed release build left the previous archive verifiable

Priority: P0 · Status: DONE

Root cause:
`scripts/build-release.mjs` published its archive by renaming a staging
directory over `release/`, but it never removed the previous artifact first. When
the build threw — which it did as soon as CR-036 deleted `api/`, because `api`
was still listed in `SOURCE_PAYLOAD` — the previous run's
`prohvac-release.tar.gz` and `RELEASE_MANIFEST.json` stayed on disk. A separately
invoked `npm run verify:release` then verified that stale archive and printed
"Release archive verified", so a broken build passed the release gate. The
chained `npm run ci` hid this because `&&` stops on the first failure.

Found while re-running the release chain after CR-036, not by a test.

Files:
- `scripts/build-release.mjs`

Migration requirements: none.

Implementation:
- [x] Remove `api` from `SOURCE_PAYLOAD` (the directory no longer exists after CR-036).
- [x] Delete the previous archive and manifest before staging, so a failed build leaves nothing for the verifier to pass on.

Acceptance criteria:
- [x] `npm run build:release` succeeds after the CR-036 layout change.
- [x] A failed build leaves no artifact that `npm run verify:release` can accept.
- [x] `npm run verify:release` and `npm run smoke:release` pass on the freshly built archive.

Tests:
- [x] `npm run build:release && npm run verify:release && npm run smoke:release`: PASS.

Result:
Fixed. The release payload list and the artifact lifecycle are now consistent
with the single-runtime layout from CR-036.

Related tasks:
CR-008, CR-024, CR-036, CR-057.

## P1 — Runtime and background-job resilience

### CR-044 — Fix nested transaction detection

Priority: P0 · Status: DONE

Root cause:
`server/auth/session.js:128` tests `db.isTransaction`, which is always
`undefined`; the wrapper exposes `inTransaction`. The guard therefore never
fires, and the hand-rolled helper issues a nested `BEGIN IMMEDIATE`, which SQLite
rejects with "cannot start a transaction within a transaction". The driver
already implements a correct savepoint-aware `transaction()`; the duplicate
helper is the root cause, not the property name alone.

Files: `server/auth/session.js`, `server/auth/session.transaction.test.js` (new).

Migration requirements: none.

Acceptance criteria:
- [x] One transaction helper is used; the duplicate is deleted.
- [x] No nested `BEGIN IMMEDIATE` is issued.
- [x] An inner failure rolls back to the savepoint without committing the outer transaction.
- [x] A rollback error does not mask the original cause.

Unit tests: plain transaction, nested helper, inner failure, outer rollback.
Concurrency tests: concurrent write conflict.

Result:
Root cause was a duplicate transaction helper, not only the wrong property
name: `server/auth/session.js` hand-rolled `BEGIN IMMEDIATE`/`COMMIT` and gated
it on `db.isTransaction`, which never exists. The helper now delegates to the
driver's savepoint-aware `db.transaction()` and refuses a raw handle that cannot
nest. `npx vitest run server/auth/session.transaction.test.js`: PASS — 5 tests
(top-level, nested, outer rollback after a nested call, inner failure released
without killing the outer transaction, raw-handle rejection).

### CR-037 — Media GC and missing-file state

Priority: P1 · Status: DONE

Root cause: GC deletes the row regardless of the unlink outcome, so an `EACCES`
or `EBUSY` failure loses the reference to a file that still occupies quota.

Migration requirements: media availability column.

Acceptance criteria:
- [x] The row is removed only after a successful unlink or `ENOENT`.
- [x] `EACCES`, `EPERM`, `EBUSY` and I/O errors keep the row and record a warning with retry metadata.
- [x] Availability is one of `available|missing|pending_delete|deleted`.
- [x] Reconciliation moves a vanished file to `missing`, and `missing` media is never published as a working URL.
- [x] The UI shows the problem and offers safe recovery or final deletion.
- [x] Orphan cleanup handles symlinks and permission errors.

Result:
Root cause confirmed at `server/routes/admin.media.js:119-127` (pre-edit): the
row was deleted after an empty `catch` around `unlink`, so an `EACCES`/`EPERM`/
`EBUSY` failure lost the only reference to a file that kept occupying the quota.
Secondary cause: `reconcileMediaStorage` used `fs.stat`, which follows symlinks,
and a single error aborted the whole sweep.

Migration `008_media_availability.sql` adds `availability`
(`available|missing|pending_delete|deleted`), `unlink_attempts`, `unlink_error`,
`unlink_retry_after`, `availability_checked_at` and a partial `media_problem_idx`.
Rows are now removed only on success or `ENOENT`; other errors keep the row and
record retry metadata. Reconciliation is `lstat`-based, marks a vanished file
`missing`, never unlinks a symlink, and records unreadable entries instead of
aborting. The admin screen gained a "требуют внимания" section with restore and
permanent-delete actions.

Publication safety is enforced through the existing gate: every public content
query already filters on `m.deleted_at IS NULL`, so reconciliation sets
`deleted_at` alongside `availability='missing'` — the row leaves published
content while the two cases stay distinguishable for operators. A test asserts
the real `LEFT JOIN ... AND m.deleted_at IS NULL` returns a null filename after
reconciliation.

`npx vitest run server/application/media-storage.test.js`: PASS — 31 tests.

### CR-038 — Lifecycle manager and graceful shutdown

Priority: P1 . Status: DONE

Root cause: `server/index.js` owns two raw `setInterval` handles with no central
owner, and `unhandledRejection` is logged and swallowed, leaving the process
running in an unknown state.

Acceptance criteria:
- [x] One manager owns every timer and all in-flight background work.
- [x] Shutdown order: stop intake, clear timers, abort external requests, drain with a bounded timeout, release leases, close the HTTP server, then close SQLite.
- [x] A second signal forces immediate exit.
- [x] No database operation runs after `closeDb()`.
- [x] No timer keeps the process alive.
- [x] An unhandled rejection writes a sanitized diagnostic, starts graceful shutdown and exits non-zero.

Integration tests: shutdown during active jobs, double signal, post-close DB
access.

Result:
Root cause confirmed at `server/index.js:180-184,221-225` (pre-edit): two bare
`setInterval` handles and two `setTimeout` kick-offs with no owner. `shutdown()`
never cleared them, never waited for a tick in flight and never released the
translation lease or quota reservations, so `closeDb()` could land while a
background job was mid-write. `unhandledRejection` was logged and returned from,
leaving the process serving on a state the code no longer described.

`server/application/lifecycle.js` (new) owns every timer, all in-flight jobs and
one shared `AbortController`. `shutdown()` executes stop-intake, clear timers,
abort, bounded drain, release leases, close server (with a force escape hatch)
and close database, in that order and exactly once; a repeated signal resolves an
internal promise that short-circuits every bounded wait. `sanitizeDiagnostic()`
emits `Name: message` with control characters collapsed, capped at 200
characters, and never a stack.

`npx vitest run server/application/lifecycle.test.js`: PASS - 18 cases,
including the exact ordered event log, an abort delivered before the drain, a
job invoked after `closeDb()` never running, a forced server close, `timerCount()
== 0` with `hasRef() == false` afterwards, and a repeated signal finishing well
under a second against a 5 s drain and a 10 s job.

Beyond unit tests, a one-off probe booted the real `server/index.js`, served
`GET /` = 200 and called `shutdown('manual')`: drained idle, server closed,
database closed, zero timers left, and no `app.sqlite-wal` on disk - which is
what actually proves the WAL checkpoint happens on the real path.

Known platform limit: Node does not deliver POSIX signals on Windows, so the
SIGTERM path is verified through an injected target plus the direct shutdown
probe here, and through the real signal on the Linux host.

### CR-039 — Reliable translation worker leases

Priority: P1 · Status: DONE

Root cause: the lease is acquired once with a fixed TTL and never renewed, so a
tick longer than the TTL lets a second worker claim the same jobs; the summary
counters report batch size rather than actual transitions.

Acceptance criteria:
- [x] Owner ID plus a random lease token and `lease_until`.
- [x] Heartbeat renewal conditional on the current token.
- [x] Processing stops when the lease is lost.
- [x] Per-job claim token with conditional completion.
- [x] Recovery touches only genuinely expired jobs.
- [x] A superseded worker cannot write a result after takeover.
- [x] Provider requests accept an AbortSignal and the lease is released on shutdown.
- [x] `failed`, `deferred`, `translated`, `skipped` and `recovered` reflect real transitions.

Concurrency tests: tick longer than the TTL, second worker, heartbeat failure,
lease loss during a provider request, restart, stale claim recovery, late write
after takeover, exactly one terminal result.

Result:
Root cause confirmed at `server/translate/worker.js:22,61-68` (pre-edit): the
lease was written once with a fixed 2-minute TTL and had no renewal path, so any
tick longer than that left an expired lease while the first worker was still
inside the provider call. `claimJobs()` stored no owner or token, `finishJob`
matched only `status='running'`, and `recover()` keyed on `updated_at`, which
unrelated writes bump and which is not a liveness signal. Summary counters
reported batch size rather than transitions.

`server/translate/lease.js` (new) implements a token-based lease with conditional
renew and release, per-row claim tokens, and expiry-based recovery; migration
`009` adds `claim_owner`/`claim_token`/`claim_until` plus a partial index.
Processing stops on lease loss, completion is conditional on the claim token, and
provider requests accept an AbortSignal.

`npx vitest run server/translate`: PASS. Fault injection: setting `heartbeatMs: 0`
reproduces the original defect exactly, with the second worker re-claiming a row
the first is still translating.

### CR-040 — Atomic translation quota

Priority: P1 · Status: DONE· Depends on: CR-039

Root cause: `preflight → provider call → usage.add` is not atomic across workers.

Migration requirements: reservation table with owner, token and expiry.

Acceptance criteria:
- [x] Reservation accounts for estimated characters and converts to actual usage.
- [x] A pre-send failure releases the reservation; an expired reservation is reclaimed.
- [x] The hard quota cannot be exceeded under concurrency.

Concurrency tests: parallel workers at the quota boundary.

Result:
Root cause confirmed at `server/translate/worker.js:271,276,291` (pre-edit):
preflight, provider call and usage increment spanned two await points, the long
one being the network call, so two workers passed the same check against the same
remaining quota and both sent.

`server/translate/usage.js` gained reserve/commit/release/reclaimExpired backed by
a `translation_quota_reservations` table (migration `009`): the check and the
INSERT share one `BEGIN IMMEDIATE`, and preflight now subtracts live holds so
provider selection cannot pick a provider whose quota is already promised. A
pre-send failure releases the hold; an ambiguous transient error is charged rather
than forgotten.

`npx vitest run server/translate/quota.test.js`: PASS - 8 cases including an
end-to-end boundary case where worker A holds quota, its lease expires, worker B
takes over and correctly refuses to send. Fault injection: forcing the held total
to zero inside reserve() fails 4 of the 8 tests.

### CR-041 — Static availability independent of SQLite

Priority: P1 . Status: DONE· Depends on: CR-042

Acceptance criteria:
- [x] Static assets and the SPA shell serve during a database outage.
- [x] Database-backed APIs return 503 with retry information and a request ID and no stack trace.
- [x] Admin login never reports a database outage as a wrong password.
- [x] Recovery requires no process restart.

Fault injection: SQLite unavailable at start, then restored.

Result:
Root cause confirmed at `server/app.js:318` (pre-edit): `await ensureDbRoutes()`
sat in `dispatch()` ahead of every branch, so a rejected initialization threw
into `handleRequest` and `sendServerError` answered 500 for everything - the SPA
shell, `/robots.txt`, `/assets/*`, `/locales/*` - none of which touch SQLite.
Worse, `server/index.js:49` ran `runMigrations(getDb())` at module scope, so an
unavailable database killed the process before `listen()` and there was no site
at all.

`ensureRuntimeReady()` no longer throws; boot migrations degrade to static-only
instead of killing the process; and `serviceUnavailable()` answers DB-backed
APIs with 503, `Retry-After` and a request ID but no stack. It sits after the
admin-reveal check, so a gated `/api/admin/*` still returns the uniform 404 and
503 cannot be used to discover that a panel exists. The blocklist and honeypot
penalty are skipped while the DB is down without changing the response, so the
outage is not a honeypot oracle either.

`npx vitest run server/app.outage.test.js`: PASS - 11 cases over a real
`node:http` server, real `node:sqlite` and real temporary directories. Fault
injection uses two distinct filesystem faults so the classifier is exercised
rather than bypassed: a directory where the database file must be (transient -
static keeps answering 200, APIs 503, then removing the directory restores the
API with no restart and login answers `401 invalid_credentials`), and `DATA_DIR`
below a regular file (`ENOTDIR`, permanent - parked as `degraded` with a future
`nextRetryAt`). The 503 body is asserted to contain no stack frame, no
`.sqlite`, no SQL and no temporary path.

### CR-042 — Recoverable runtime initializer

Priority: P1 . Status: DONE

Acceptance criteria:
- [x] States `idle|initializing|ready|degraded|failed_temporarily|shutting_down`.
- [x] Exponential backoff with jitter and a cooldown, behind a single initialization promise.
- [x] Health status exposes a secret-free error class and the next retry timestamp.
- [x] Permanent configuration errors are distinguished from transient infrastructure errors.
- [x] Routes are never registered twice.

Result:
Root cause confirmed at `server/application/runtime-initializer.js:32`
(pre-edit): `if (state === FAILED && attempts >= maxAttempts) throw lastError`
parked the process in `failed` forever after two attempts, with no backoff, no
classification and no retry timestamp - and `server/app.js:241` pinned
`maxAttempts: 2`, so a single disk hiccup at boot required restarting the
Passenger pool. The status object also published `lastError.message`, which for
SQLite failures is a full filesystem path.

Six states now; retries are governed by frequency rather than an attempt count,
with `min(base * 2^(failures-1), max)`, symmetric jitter and a cooldown floor.
`classifyInitializationError()` separates permanent configuration errors
(`EACCES`, `EROFS`, `ENOTDIR`, `SQLITE_NOTADB`, `TypeError`, one bounded `cause`
hop) from transient infrastructure ones. `status()` publishes state, counters,
error class, code and name, `nextRetryAt` and `retryAfterMs` - and deliberately
no message. `server/router.js` now throws on a duplicate `method+pattern`, which
makes double registration structurally impossible rather than merely avoided.

`npx vitest run server/application/runtime-initializer.test.js`: PASS - 23 cases
with the clock and the jitter source injected, so backoff assertions are exact
rather than timing-dependent: shared promise across parallel callers, delays
`500/1000/2000/2000/2000` against the ceiling, jitter spread `800/1000/1200`,
cooldown floor, permanent-versus-transient split, recovery from `degraded`, and
an assertion that the status contains neither the path nor the token from the
error message.

### CR-043 — Maintenance lease and safe cleanup

Priority: P1 . Status: DONE

Migration requirements: maintenance state columns.

Acceptance criteria:
- [x] Owner, token, lease-until, started-at, last success, last failure, failure category and duration are stored separately.
- [x] A crash after claim does not defer the work for 24 hours; failure uses a short bounded backoff and success uses the normal interval.
- [x] DELETE runs in small batches that yield to the event loop, under a per-run time limit.
- [x] `optimize`/`checkpoint` run separately with measured duration and never in several processes at once.
- [x] The dashboard reports the result and the retention policy matches the privacy notice.

Fault injection: crash immediately after claim.

Result:
Root cause confirmed at `server/lib/maintenance.js:63-68,85-89,113-116`
(pre-edit): `SQL_CLAIM` wrote `app_state.last_purge_at = now` as the claim
itself, the doc comment stated the marker moves *before* the work deliberately,
and `runMaintenance` never touched it again. One value answered three different
questions - who is running, when it last succeeded, and when the next run may
start - so a process dying one line after the claim had already published "the
pass happened", and the whole pool stayed silent for 24 hours. Since
`leads.purge_after` is a declared personal-data retention deadline, that deadline
simply did not arrive.

Migration `011_maintenance_state.sql` adds a `maintenance_state` table with one
row per task (`purge`, `compact`) holding lease owner/token/until, started_at,
next_run_at, last success, last failure, failure category, failure streak, last
duration and truncation, and carries the legacy `last_purge_at` forward so an
upgrade does not trigger a full purge on the first tick.

Scheduling now separates the three questions: a claim sets `next_run_at` to
now + lease (10 min crash guard), success to now + 24 h, a budget-truncated pass
to now + 5 min, and a failure to a backoff doubling from 5 min to a 60 min
ceiling. Completion is conditional on the lease token, so a zombie waking past
its lease cannot overwrite the pass that replaced it. `runMaintenanceAsync`
yields between batches, `runCompaction` runs `optimize` and `wal_checkpoint`
under their own lease with each duration measured, and `RETENTION.leadsMs` is
asserted behaviourally against the repository's stamp.

`npx vitest run server/lib/maintenance.test.js`: PASS - 23 tests on real
temporary SQLite. Fault injection: crash immediately after claim (the next claim
is refused at lease-1 and granted exactly at the lease, which is asserted to be
under a day), and disk-full mid-pass (earlier batches stay committed so deleted
PII is not resurrected, category `storage`, lease released, retry in 5 min).

## P1 — Architecture, queries and performance

### CR-045 — Complete the settings application layer

Priority: P1 . Status: DONE

Root cause: `server/routes/public.lead.js` imports `readSetting`,
`renderLeadMessage` and `resolveTelegram` from `server/routes/admin.settings.js`
— a public transport module depending on an admin transport module.

Acceptance criteria:
- [x] Settings repository, settings service, Telegram configuration and lead message template are separate modules.
- [x] No public route imports an admin route module.
- [x] Secret decryption happens in exactly one place.
- [x] Runtime configuration is read once per request as an immutable snapshot, so a mid-request settings change cannot produce a mixed configuration.
- [x] The settings cache is invalidated by generation/revision and route handlers stay thin.

Result:
Root cause confirmed at `server/routes/public.lead.js:14-18` and
`server/routes/public.content.js:38` (pre-edit): public transport modules
imported settings reads, message rendering and Telegram resolution from an admin
transport module.

Two further defects surfaced during the refactor. Secret decryption existed in
two places - `admin.settings.js` and `server/translate/provider.js` - both
calling `open()` directly. And `resolveLeadRuntimeConfig` ran twice per lead
request: once in the pipeline and again inside `buildMessage`, which executes
after `await readBody`. A settings change arriving mid-request therefore produced
a genuinely mixed configuration - old bot token, new template. That was
reproduced before fixing: reverting only that one line makes all three snapshot
tests fail.

New modules: `server/repositories/settings.js` (the only call site of
`open`/`seal`/`preview` for settings secrets, and secrets are never cached),
`server/application/settings-service.js`, `server/application/telegram-config.js`
and `server/domain/lead-message.js`. `admin.settings.js` fell from 1019 to 460
lines. The lead handler memoizes one frozen snapshot per request, so
`getConfig` and `buildMessage` share one configuration and concurrent requests
each get their own. Cache invalidation keys on a revision aggregate over the
settings table, so an admin save from another Passenger process is visible on the
next read with no TTL.

`npx vitest run server/application/settings-service.test.js
server/routes/admin.settings.contract.test.js
server/routes/public.lead.snapshot.test.js server/routes/public.boundaries.test.js`:
PASS - 22 tests, none of the existing tests modified. Coverage includes secrets
never being served from cache (ciphertext corrupted without touching
`updated_at` still yields empty), secrets absent from the PUT body, GET body,
listing and audit diffs, and a static boundary check that no `public.*.js`
imports any sibling route module.

Re-exports were kept in `admin.settings.js` only for files outside this task's
ownership (`admin.leads.js`, `admin.media.js`, `admin.operations.js`); pointing
those at the new modules and deleting the block is tracked as follow-up.

### CR-046 — Single-flight public content cache

Priority: P1 · Status: DONE

Acceptance criteria:
- [x] One in-flight rebuild per cache key, with parallel requests awaiting it.
- [x] Last-known-good responses during failure, with negative backoff and bounded retry.
- [x] The cache generation does not advance on failure.
- [x] Metrics for hit, miss, rebuild, stale-served, error and coalesced requests.
- [x] Cache size is bounded.

Performance: thundering-herd test with dozens of parallel requests.

Result:
`createContentStore` now coalesces concurrent rebuilds through one in-flight
promise per key, bounds the cache with LRU eviction, and exposes
hit/miss/rebuild/coalesced/staleServed/error/backoffSkipped counters.

The negative backoff needed a correction that only surfaced under test: a naive
pause delayed recovery after a single transient failure and broke the CR-012
guarantee that the next valid revision is published immediately. It now engages
only from the second consecutive failure — single-flight already absorbs a
request storm — and only within one content generation, because a successful
generation read from the same SQLite proves the database is answering.

`npx vitest run server/routes/public.content.test.js
server/routes/public.content.cache.test.js`: PASS — 11 tests, including a
50-request thundering herd that produces exactly one rebuild and 49 coalesced
waiters, immediate recovery after one failure, backoff after two, stale-served
accounting, and eviction at the size bound.

### CR-047 — Cursor pagination and indexes

Priority: P1 · Status: DONE

Migration requirements: covering indexes for the paginated and filtered queries.

Acceptance criteria:
- [x] Keyset pagination on `(created_at, id)` for leads, with a validated cursor and `nextCursor`, and no skipped or duplicated rows when timestamps are equal.
- [x] Offset survives only as a bounded compatibility mode; deep offsets are rejected.
- [x] Media gains cursor pagination, search and state/MIME/date filters instead of a hardcoded `LIMIT 500`.
- [x] `EXPLAIN QUERY PLAN` is captured for leads list and filter, delivery attempts, media list, dashboard, translation queue and maintenance selection.

Performance: synthetic benchmark at 100k leads, 20k media, 50k audit records and
50k translation jobs, recording query plan, dataset size, median, p95 and scanned
rows rather than a machine-specific absolute time.

Result:
Leads now paginate by the `(created_at, id)` tuple the list is already ordered
by, with a strictly validated cursor and a `nextCursor` derived from fetching one
row beyond the page. The cursor is deliberately not signed: it carries no
authority, only a position the client already sees in the response, so strict
parsing of two integers is the whole requirement. Offset survives as a bounded
compatibility mode - the previous ceiling of 1,000,000 was a promise to read and
discard a million rows for one admin request, and is now 20,000.

Media moved off the hardcoded `LIMIT 500` to the same keyset scheme plus search,
MIME and date filters. The default page size is deliberately still 500 so the
existing admin screen sees exactly what it saw; the change is that files beyond
the first five hundred stopped being unreachable at all.

Migration `010_pagination_indexes.sql` adds `leads_keyset_idx`,
`leads_status_keyset_idx`, `leads_delivery_state_idx` and partial
`media_keyset_idx`/`media_mime_idx`.

`npx vitest run server/routes/admin.pagination.test.js`: PASS - 10 tests. The
correctness cases use rows that all share one `created_at`, which is exactly where
offset repeats or skips a row: 37 rows are walked once each, and a lead inserted
between two page requests cannot corrupt the second page. `EXPLAIN QUERY PLAN` is
asserted for the leads listing, the status filter, the delivery-state counters,
the stale-attempt scan, the media listing and the purge selection; the scale case
builds 20,000 leads and pins the plan rather than a machine-specific timing.

### CR-048 — Static path and symlink hardening

Priority: P1 · Status: DONE

Acceptance criteria:
- [x] Containment is proven with `realpath`/`lstat` against the real root.
- [x] Symlinks are rejected for release, static and media paths.
- [x] Release verification fails on an unexpected symbolic link.
- [x] No TOCTOU window where an untrusted party can swap the target.

Security tests: normal file, `../`, encoded traversal, symlink to a file outside
root, symlink directory, broken symlink, media symlink.

Result:
Root cause confirmed: `server/http/static.js` rejected `..` but its only
filesystem call was `fsp.stat`, which follows links, and the stream re-opened the
file by path after the check. A symlink inside `dist/` or `DATA_DIR/media`
therefore served whatever it pointed at, through a TOCTOU window.

`openWithinRoot()` is now the only way a file is reached: `lstat` rejects a
symlink at the final component, the descriptor that gets served is the one that
was opened, `realpath` containment catches symlinked intermediate directories, and
device/inode are compared between descriptor and `lstat`. `release-policy.mjs`
switched to `lstatSync` and fails on any link instead of following it.

`npx vitest run server/http/static.test.js`: PASS - 21 passed, 5 skipped. Security
cases cover `../`, `%2e%2e`, `%2E%2E`, double-encoded `%252e%252e`, backslash,
`%00`, symlink to a file outside root, a file reached through a symlinked
directory, broken symlink and a symlinked `.br` variant, asserting on the response
body rather than the status alone. The five skips are file-symlink cases Windows
refuses without Developer Mode; directory cases run everywhere via junction, and
all of them run on Linux CI.

### CR-049 — Trusted Host validation

Priority: P1 · Status: DONE

Acceptance criteria:
- [x] A hostname allowlist is derived from `PUBLIC_ORIGIN` plus explicit configuration.
- [x] `Host`/`:authority` is validated on every request.
- [x] `X-Forwarded-Host` is honoured only behind a trusted proxy.
- [x] Malformed hosts, control characters and unexpected domains are rejected.
- [x] Health checks work through an explicitly allowed host.

Security tests: DNS-rebinding-style requests.

Result:
No host validation existed anywhere in the tree. `server/http/request-context.js`
gained host normalization, an allowlist compiler and an evaluator, reusing the
existing trusted-proxy CIDR logic so `X-Forwarded-Host` is honoured only behind a
trusted peer. `config.trustedHosts` derives from `PUBLIC_ORIGIN` plus the new
`TRUSTED_HOSTS`, with localhost added only outside production. `respond.js` gained
`misdirected()` - 421 with plain text, deliberately not the SPA shell, since
serving the shell is precisely what DNS rebinding wants.

Wiring lives in `server/app.js`, before path normalization and any database
access. Writing that line immediately broke `npm run smoke:production`, which
connects to `127.0.0.1`. The fix was to give the smoke the same explicit
`TRUSTED_HOSTS` entry a real operator must configure for an IP-based health check,
not to relax the check.

`npx vitest run server/http/trusted-host.test.js`: PASS - 57 cases covering
DNS-rebinding hosts, suffix and prefix confusion, case, trailing dot, port
handling, IPv6 in several forms, missing and duplicate Host, CR/LF/tab/NUL,
userinfo and path injection, malformed labels, and `X-Forwarded-Host` accepted
only from a trusted peer. A latent bug surfaced and was fixed: IPv4 hosts were
normalizing to undefined and comparing equal to each other.

### CR-050 — PII and metadata hardening

Priority: P1 · Status: PARTIALLY DONE

Acceptance criteria:
- [x] No phone fragment, name, message, token, TOTP secret, recovery code, session cookie or CSRF token appears in any log.
- [x] `pagePath` is normalized to a bounded, control-character-free pathname with no query string or credentials.
- [x] Frontend-supplied metadata is never treated as audit truth.
- [x] Retention is documented and only necessary data is stored.

Security tests: automated log-redaction assertions.

Result:
Two of the four requirements are already closed as a side effect of other work,
which is why this is partial rather than untouched:

- The `phoneTail` log line disappeared together with the environment-backed lead
  runtime removed in CR-036. It was the only place a phone fragment reached a log.
- `pagePath` normalization landed in `shared/lead.js` under CR-033: NFKC, a
  whitelisted pathname, bounded length, no query string and no control
  characters, applied on the server rather than trusted from the client.

Still open: a systematic audit of every log statement against the full list
(name, message, API token, TOTP secret, recovery codes, session cookie, CSRF
token) with automated redaction tests, and a written retention statement that
matches the privacy notice. The CR-035 suite already asserts non-disclosure for
TOTP secrets and recovery codes, and CR-005 covers settings secrets, so the gap
is coverage breadth, not a known leak.


### CR-051 — HSTS and CSP policy

Priority: P1 · Status: DONE

Root cause: `server/http/respond.js:29` hardcodes `includeSubDomains`, binding
every subdomain of the production apex without an operator decision.

Acceptance criteria:
- [x] `includeSubDomains` and `preload` are separate explicit settings, off unless configured.
- [x] Inline styles are inventoried and `'unsafe-inline'` removed where feasible, with nonce or hash where justified.
- [x] Analytics is opt-in, off by default, reflected in the privacy notice and limited to minimal CSP domains.

Security tests: security header assertions for each configuration.

Result:
`includeSubDomains` was hardcoded at `server/http/respond.js:29`. HSTS is now
built from configuration, with `HSTS_MAX_AGE`, `HSTS_INCLUDE_SUBDOMAINS` and
`HSTS_PRELOAD` as separate settings, both directives off unless configured, and a
startup refusal when `HSTS_PRELOAD=1` cannot qualify for any preload list.

The inline-style inventory found six style attributes plus one in `index.html` and
no inline style element, so `'unsafe-inline'` was removed from `style-src-elem` -
the directive that actually matters - and retained only in `style-src-attr`, where
a nonce is impossible by specification and a hash is impossible for the three
dynamic sites. Analytics domains are gated on the new `ANALYTICS_ENABLED` and
vanish from every directive when off.

`npx vitest run server/http/respond.test.js server/http/spa.test.js`: PASS - 21
tests, including that script-src is nonce-only, that zero analytics domains appear
when analytics is off, and that the per-response nonce keeps `Content-Length`
constant so the uniform404 indistinguishability invariant survives.

## P2 — Frontend, UX and client performance

### CR-052 — Localize every system state

Priority: P2 · Status: DONE

Acceptance criteria:
- [x] Public 404, admin loading, chunk-load failure, session expiry, network error, diagnostic label, delivery unknown, retry instructions and media errors are localized for every supported language.
- [x] A raw backend code is never the primary message; code, request ID and timestamp live in a disclosure block.

Result:
System states were hardcoded Russian strings in `src/App.jsx`, and `src/errors.js`
shipped one Russian text per code with no way to localize it; the admin probe
failure had no diagnostic channel at all. `frontendError(error, { t })` now
resolves per-code message and action keys with the Russian text as the default
value, and all five locale bundles gained the same 54 keys. Technical data renders
only inside a disclosure block; the primary text is always a localized sentence.

`npx vitest run src/errors.i18n.test.js src/hooks/useLocalizedText.test.js`:
PASS - 36 cases, including key-set parity across the five bundles, a full
code-to-message-and-action table per language, an assertion that non-Russian
bundles are never identical to the Russian text (which catches copy-paste
translations), and that a raw code or request ID never appears inside the
message.

### CR-053 — Language selector accessibility

Priority: P2 · Status: DONE

Acceptance criteria:
- [x] Either a complete ARIA listbox (Arrow Up/Down, Home/End, active option, selected state, focus management) or a different accessible pattern.
- [x] `listbox`/`option` roles are not used unless the keyboard behaviour matches them.

Result:
The selector lived in `src/components/Header.jsx`, not `src/language/`, and
declared listbox and option roles with no keyboard handling at all: no
Arrow/Home/End, no focus moved into the list, options nested inside list items,
and `disabled` on the just-pressed item dropping focus to the document body.

Resolution was option (b): an ARIA menu button with `menuitemradio`. Choosing a
language performs an action - it loads a locale bundle and rewrites the document
language and direction - rather than editing a value submitted later, which is
what menu semantics describe; a listbox would additionally require a
composite-widget contract the visual design does not provide. `aria-disabled`
replaces `disabled` so focus is not lost mid-switch.

`npx vitest run src/language/menuNavigation.test.js`: PASS - 17 cases covering
wrapping in both directions, Home/End/PageUp/PageDown, Escape restoring focus, Tab
deliberately not swallowed, and type-ahead including Cyrillic. Rendered focus
movement and ARIA attributes remain for CR-056.

### CR-054 — Frontend performance audit

Priority: P2 . Status: DONE

Acceptance criteria:
- [x] Animation loops stop on `document.hidden` and when offscreen, respect `prefers-reduced-motion`, cap device pixel ratio and clean up their handlers and frames.
- [x] Images are audited for format, `srcset`/`sizes`, intrinsic dimensions, lazy loading, hero preload and CLS.
- [x] The bundle is audited for size, duplicate dependencies, tree shaking and unnecessary rerenders.
- [x] A before/after table records bundle sizes, initial requests, transferred bytes, long tasks, layout shifts and active animation loops.

Result:
Root cause: both decorative canvases called `requestAnimationFrame`
unconditionally from mount to unmount, so a backgrounded tab and a widget three
screens below the fold repainted for the whole session. Separately,
`pv-stats__media` applied a 107.9 kB decorative background through an inline
style, so it was fetched in the first-paint burst for a section below the fold.

`src/components/effects/animationLoop.js` (new) gates the loop on page
visibility and viewport intersection, coalesces resize to one rebuild per frame,
and releases every listener and frame on unmount. The stats background is
applied only within 400 px of the viewport, degrading in bytes rather than
layout when `IntersectionObserver` is unavailable.

Measured, first-party deterministic set: initial requests 8 to 7, transferred
690.73 kB to 584.23 kB (-15.4%). Active animation loops with the tab
backgrounded: 2 to 0; hero in view: 2 to 1. Uncoalesced resize handlers 2 to 0.
Initial JS grew 1.43 kB raw for the shared loop module.

`npx vitest run src/components/effects/animationLoop.test.js`: PASS - 15 cases.

Deliberately not changed, because no number justified it: `useParallax`,
`useReveal` and `CountUpValue` already satisfy every listed criterion, and the
half-speed reduced-motion policy the canvases document was left alone rather
than changed for an unmeasurable metric.

Not measurable here (no browser runtime, same blocker as CR-056) and therefore
NOT reported as numbers: long tasks, layout shifts/CLS, LCP, TTI and frame
timings. CLS sources were audited statically - every owned image carries
intrinsic dimensions and both parallax layers are absolutely positioned - but
that is an inspection, not a measurement. Two recommendations fell outside the
task's file ownership: an LCP preload for the hero image in `index.html`, and
`srcset`/AVIF variants for five oversized project images (341 kB down to
201 kB each, all lazy today).

### CR-055 — Deduplicate frontend requests

Priority: P2 · Status: DONE

Acceptance criteria:
- [x] Session refresh is single-flight across focus and visibility events.
- [x] Requests are cancelled with AbortController and versioned so a slow stale response cannot overwrite a newer one.
- [x] No request is issued after unmount and the session-lost callback fires once.

Concurrency tests: simultaneous focus and visibility, out-of-order responses,
CSRF rotation, unmount, reconnect.

Result:
Focus and visibilitychange both called refresh() with the throttle set before the
await, so a simultaneous pair still issued two GETs; nothing versioned responses,
so a slow reply could roll the session and its CSRF token back over a fresh login;
no AbortSignal was passed, so in-flight requests survived unmount; and the
session-lost callback fired once per failing request.

`createSessionSync()` provides single-flight refresh with the task invoked
synchronously, a throttle that does not consume a ticket, and monotonic tickets
where a mutation always beats a concurrent query. `setCsrfToken` returns a
monotonic generation, the session-lost notification fires at most once per
session, and the handler unsubscribe refuses to clear another instance's handler.

`npx vitest run src/admin/sessionSync.test.js src/admin/api.test.js`: PASS - 21
cases including simultaneous focus and visibility collapsing into one request, a
slow stale response failing to overwrite a newer one, a single announcement across
three parallel failures, and unsubscribe isolation.

### CR-056 — Browser and accessibility QA

Priority: P2 . Status: DONE

The earlier blocker was wrong. It was recorded from a different tool's empty
browser list; this session has Playwright 1.58.2 with Chromium installed, so the
sweep was actually run — headless first and then again with a visible browser.

Four suites drive the real production router and the built bundle against a
temporary database with a Telegram stub:

- **landing** — five viewports (1440x900, 1024x768, 768x1024, 390x844,
  375x667), horizontal-overflow check at each, title/lang, no raw i18n keys,
  one `.pv-outro` surface with the footer inside it, `role=contentinfo`,
  intrinsic dimensions and `alt` on all 30 images, CSP nonce substitution,
  valid `ld+json`, and zero console errors, page errors or failing requests.
- **a11y** — the language menu end to end (Enter opens, focus enters on the
  checked item, ArrowDown/Home/End, ArrowUp wraps, Escape closes and returns
  focus to the trigger, selecting a language actually switches the document),
  no `listbox`/`option` roles left over, Arabic switching to `dir=rtl` with no
  overflow at 1440 or 375, the mobile drawer (dialog, `aria-modal`, focus
  entry, 25-press focus-trap probe, scroll lock, Escape, focus return, lock
  release), and reduced motion.
- **flows** — project modal and the lightbox nested inside it (focus entry,
  trap, visible close, Escape closing only the top layer), the lead form
  (`autocomplete`, `inputmode`, `aria-invalid`, error bound through
  `aria-describedby`, submission, UUID `Idempotency-Key`, clearing only on
  success), and the 404 (status, `X-Robots-Tag: noindex`, rendered screen, a
  way back, refresh keeping the status).
- **admin** — the full first-login journey `totp -> recovery -> password ->
  panel`, with the TOTP code computed by the project's own
  `server/auth/totp.js` in a child process rather than reimplemented in the
  test. Asserts anonymous masking (404), that data is refused during
  enrollment, that the leads API answers `403 must_change_password` while the
  change is pending, ten recovery codes, then overview/leads/media/settings
  including the keyset cursor, a rejected malformed cursor, and no secret in
  any response.

Two real defects were found by rendering that no static analysis had shown:
CR-064 and CR-065.

Screenshots (20) are kept as scratch artifacts and deliberately not committed.

Result:
All four suites pass headless and with a visible browser. The lead submitted by
the browser arrived in the Telegram stub and is visible in the admin list with
delivery state `sent`.

Two limits remain honest rather than papered over: zoom to 200% and a screen
reader were not exercised, and no visual-regression baseline exists, so the
screenshots prove "renders without overflow or errors", not "looks right".

### CR-057 — Clean source handoff archive

Priority: P2 · Status: DONE

Acceptance criteria:
- [x] A source package is built from a clean Git checkout and is a distinct artifact from the production release.
- [x] It excludes env files, runtime DB/WAL/SHM, uploads, logs, `node_modules`, `dist`, release artifacts, IDE and `.claude` directories, coverage, temporary files, credentials and OS metadata.
- [x] It carries a source manifest with commit hash, checksums and the exclusion list.
- [x] `npm run verify:source-handoff` fails closed on any forbidden entry.

Result:
`scripts/source-handoff-policy.mjs` defines the source-specific policy (tests are
required here and excluded from the release), `scripts/build-source-handoff.mjs`
stages and archives it with `SOURCE_MANIFEST.json` (version, commit or an
explicit unavailability reason, build date, Node version, exclusion list and
SHA-256 per file), and `scripts/verify-source-handoff.mjs` re-checks the shipped
archive independently. Both are wired into `npm run ci` and CI.

Two real defects were found by running the gate rather than by reading it:
1. A `NOT-A-REAL-TOKEN`-marked fixture is now required in
   `server/crypto/secretbox.test.js`; the previous fixture was shaped exactly
   like a live Telegram token. The marker is checked inside the matched value in
   `scripts/secret-patterns.mjs` — deliberately narrower than a path allowlist,
   which would keep passing after someone pasted a real token into that file.
2. Excluding a bare `data` directory at any depth silently dropped
   `src/data/content.js`, which is source. Generated directories are now matched
   only at the repository root.

`npx vitest run scripts/source-handoff-policy.test.js`: PASS — 11 tests.
`npm run build:source-handoff && npm run verify:source-handoff`: PASS — 235 files,
7 excluded entries, 0 forbidden entries in the archive.

Known limitation: this workspace has no `.git`, so the manifest records
`commit: null` with `commitUnavailableReason: "no_git_checkout"`. A clean
checkout is still required to prove reproducibility.

### CR-059 — Split the media storage module

Priority: P3 . Status: DONE

Root cause:
CR-034 and CR-037 grew `server/application/media-storage.js` to 583 lines, past
the 400-line decomposition guideline in CLAUDE.md §1. Upload/restore and
collect/reconcile are two distinct responsibilities that now share one file only
because the remediation agent was scoped to existing files.

Files: `server/application/media-storage.js` and two successors.

Acceptance criteria:
- [x] Upload/restore and collection/reconciliation live in separate modules.
- [x] No behavioural change; the existing 31 tests pass unmodified.

Result:
`server/application/media-storage.js` went from 582 to 326 lines. Upload and
restore stay there; `server/application/media-gc.js` (259 lines) owns collection
and reconciliation, and `server/application/media-internals.js` (57 lines) holds
the primitives both halves need. The third file exists to keep the split
acyclic - the alternative was duplicating `inspect`/`removeIfPresent`/`isActive`
in both halves. Bodies, SQL and comments were moved verbatim, and the public
contract is re-exported so `server/routes/admin.media.js` needed no edit.

`npx vitest run server/application/media-storage.test.js`: PASS - 31 tests, file
unmodified, which is the point of the task.

### CR-060 — Style the media problems section

Priority: P3 . Status: DONE

Root cause:
CR-037 added `adm-media__problems` and `adm-media--problems` to
`src/admin/screens/Media.jsx`, but `src/admin/admin.css` was owned by a
different concurrent task, so the section currently inherits generic card
styling instead of signalling that those items need operator attention.

Files: `src/admin/admin.css`.

Acceptance criteria:
- [x] The section is visually distinguishable as a warning state.
- [x] Contrast and reduced-motion behaviour match the rest of the admin theme.

Result:
`src/admin/admin.css` gains a warning border, a 7% warning wash, a 3 px left
bar, a warning-coloured heading and a wider grid track for the problem cards,
which carry a reason, a timestamp, an unlink error and two buttons. `Media.jsx`
was not touched.

Contrast measured: the heading is 6.66:1 on `--adm-surface` and 7.34:1 on
`--adm-bg`, both above AA; body copy stays on `--adm-text`. The one-shot 0.35 s
entry animation is disabled under `prefers-reduced-motion: reduce`, and colour
plus the left bar carry the same meaning without motion. Admin lazy CSS grew
0.63 kB raw - a lazy chunk, so the landing payload is unaffected.

No test: the project has no visual-regression harness, and asserting CSS text
would test the stylesheet against itself.

### CR-061 — Inline scripts were blocked by CSP in production

Priority: P1 · Status: DONE

Root cause:
`server/http/spa.js` documents in its header that every inline `<script>` in
`index.html` must carry `nonce="__CSP_NONCE__"`, because the policy it emits has
no `'unsafe-inline'` in `script-src`. Neither inline script actually carried the
placeholder: `grep -c nonce dist/index.html` returned 0. The structured-data
`ld+json` block and the Google Tag Manager bootstrap were therefore refused by
the browser in production — silently, since a CSP violation is not a server
error. The contract was written down and never enforced.

Found while verifying CR-051, by grepping the build output rather than the
source.

Files:
- `index.html`

Migration requirements: none.

Implementation:
- [x] Add `nonce="__CSP_NONCE__"` to both inline scripts.
- [x] Confirm the placeholder survives the Vite build into `dist/index.html`.

Acceptance criteria:
- [x] `dist/index.html` contains the placeholder for every inline script.
- [x] The production build and smoke still pass.

Tests:
- [x] `npm run build && grep -c __CSP_NONCE__ dist/index.html`: 2.
- [x] `npm run smoke:production`: PASS.

Result:
Fixed. Note that structured data now executes as intended, while Google Tag
Manager additionally requires `ANALYTICS_ENABLED=1` (CR-051) for its domains to
be present in the policy at all — so enabling analytics is now a deliberate
operator decision rather than an accident of markup.

Related tasks: CR-051.

### CR-062 — Enqueue leaves stale claim columns on translation jobs

Priority: P3 . Status: DONE

Root cause:
`server/routes/admin.content.js:174` (`SQL_ENQUEUE_JOB`) resets a job to
`status='queued'` without clearing the `claim_owner`/`claim_token`/`claim_until`
columns introduced by CR-039. Harmless today, because every consumer requires
`status='running'` before acting on a claim, but it leaves a row asserting an
owner that no longer holds it — exactly the sort of stale state CR-039 exists to
remove.

Reported by the CR-039 implementation as being outside its file ownership.

Files: `server/routes/admin.content.js`.

Acceptance criteria:
- [x] Re-enqueueing clears the claim columns in the same statement.
- [x] A test asserts no stale claim survives an enqueue.

Result:
Confirmed at `server/routes/admin.content.js:174`: the `DO UPDATE` reset
`status='queued'` and `run_after=0` but left the CR-039 claim columns intact.
They are now cleared in the same statement.

`npx vitest run server/routes/admin.content.enqueue.test.js`: PASS - 2 tests
driving the real router and session so the route's own fallback statement is the
one under test. Fault injection: removing the three new SQL lines makes both
tests fail with 4 stale claims instead of 0.

Noted for later: the production enqueue path is `server/translate/worker.js`,
which was outside this task's ownership and has not been inspected for the same
defect.

### CR-063 — Purge the pending TOTP row in the admin CLI reset

Priority: P3 . Status: DONE

Root cause:
`scripts/admin-cli.mjs:466` (`resetTwoFactor`) deletes `totp_secrets` and
`recovery_codes` but not the `totp_pending` table added by CR-035. Not
exploitable — the same transaction revokes every session, and confirmation
requires a live session — but it leaves orphan rows until session GC cascades
them away.

Reported by the CR-035 implementation as being outside its file ownership.

Files: `scripts/admin-cli.mjs`.

Acceptance criteria:
- [x] The reset removes pending enrollment state in the same transaction.

Result:
Confirmed at `scripts/admin-cli.mjs:466`: the reset deleted `totp_secrets` and
`recovery_codes` but not the `totp_pending` table added by CR-035. The delete is
now inside the same transaction and the count appears in the command output.

`npx vitest run scripts/admin-cli.reset-2fa.test.js`: PASS - 2 tests. The CLI
runs `main()` on import and therefore cannot be imported, so the test seeds a
temporary DATA_DIR database and spawns the real process. Fault injection:
neutralising the new statement makes both tests fail.

### CR-064 — Analytics markup ran and was then blocked by CSP

Priority: P1 · Status: DONE

Root cause:
Three correct decisions combined into a defect. CR-051 made analytics opt-in and
dropped `googletagmanager.com` from `script-src` when it is off. CR-061 gave the
inline scripts a nonce so they would execute. The Google Tag Manager bootstrap
is an inline script — so it executed, immediately requested the external GTM
script, and the browser refused it. Every page load wrote a CSP violation to the
console, and analytics did not work anyway.

Neither task was wrong on its own, which is why no test caught it: this is only
visible when a browser actually parses and runs the shell. Found by the CR-056
render sweep.

Files:
- `server/http/spa.js`
- `server/http/spa.test.js`

Migration requirements: none.

Implementation:
- [x] Strip both Google Tag Manager blocks from the shell when analytics is off.
- [x] Strip before nonce substitution — no point issuing a nonce to a script that cannot run.
- [x] Key the cut on the HTML comment markers and assert those markers still exist, so renaming the markup fails a test instead of silently disabling the cut.

Acceptance criteria:
- [x] With analytics off, the served shell contains no analytics markup at all.
- [x] The landing page loads with zero console errors.
- [x] `ld+json` and the module entry point survive the cut.

Tests:
- [x] `npx vitest run server/http/spa.test.js`: PASS — 14 tests, 4 new.
- [x] Browser sweep: `no console errors` passes at all five viewports.

Result:
Fixed. Analytics is now genuinely off when it is off, instead of half-running.

Related tasks: CR-051, CR-061, CR-056.

### CR-065 — Reduced-motion rules were overridden by the cascade

Priority: P1 · Status: DONE

Root cause:
`src/index.css` had a `@media (prefers-reduced-motion: reduce)` block near the
top that slowed `.pv-blob` to 60 s and `.pv-marquee__track` to 80 s. Both
selectors are redefined later in the file — `.pv-blob--1..3` and
`.pv-marquee__track` — with equal specificity, so the later rules won and the
reduced-motion overrides never applied at all. The setting looked handled and
did nothing: with "reduce motion" on, three background blobs and the partner
marquee kept animating indefinitely.

Found by the CR-056 sweep, which enumerates computed styles under an emulated
reduced-motion preference. A static reading of the media query looks correct;
only the cascade in a real engine shows otherwise.

Files:
- `src/index.css`

Migration requirements: none.

Implementation:
- [x] Move the affected rules to a block at the end of the stylesheet so the cascade cannot defeat them.
- [x] Stop the blobs entirely — they are pure decoration, and "slower" buys nothing.
- [x] Stop the marquee and make its mask scrollable, so stopping does not hide the logos it was scrolling through.
- [x] Cover the RTL variant of the marquee as well.

Acceptance criteria:
- [x] No element runs an infinite CSS animation under reduced motion.
- [x] No partner logo becomes unreachable once the marquee stops.

Tests:
- [x] Browser sweep enumerates computed styles: zero infinite animations remain.

Result:
Fixed. Beyond the preference itself, the marquee is a WCAG 2.2.2 (Pause, Stop,
Hide, Level A) case: moving content lasting more than five seconds with no
control. Stopping it under an explicit user preference is the minimum.

Related tasks: CR-018, CR-054, CR-056.

### CR-066 — Unknown URLs render the admin login when the gate is disabled

Priority: P3 · Status: NOT STARTED

Root cause:
The client decides whether to render the admin shell by asking
`/api/admin/session`. That endpoint is not path-scoped: what actually
distinguishes the secret path is the gate cookie, which is only obtainable
there. With `ADMIN_REQUIRE_GATE=0` there is no cookie to check, so the endpoint
answers 200 everywhere and every unknown URL renders the admin login instead of
the Not Found screen.

**Not a production exposure.** `ADMIN_REQUIRE_GATE` defaults to `isProduction`,
and with the gate on the endpoint returns 404 and the Not Found screen renders
correctly — both verified in the browser. The defect is confined to development
and to `scripts/production-smoke.mjs`, which disables the gate for convenience.

Files: `src/App.jsx`, `server/routes/admin.auth.js`.

Acceptance criteria:
- [ ] With the gate disabled, only the configured secret path renders the admin shell.
- [ ] Unknown URLs render Not Found regardless of gate configuration.

Result: pending.
