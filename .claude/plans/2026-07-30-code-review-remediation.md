## Goal
Make the current PROHVAC repository production-safe across authentication, lead delivery, settings, media, public/admin UX, tests, CI, release packaging, and operations.

## Done when
- Every P0 item is verified by integration tests and no rejected lead request stores PII.
- Lint, all tests, production build, migration/startup/API/browser smokes, and release verification pass from a clean install.
- Contact and Footer remain the only sections inside one continuous outer glass surface; earlier page layout is unchanged.

## In scope
- `server/`, `api/`, `shared/`, `src/`, migrations, tests, CI/release scripts, `.env.example`, and project documentation.
- Backward-compatible schema/data migrations and focused application-service extraction.

## Out of scope
- Live infrastructure changes, real Telegram/DeepL calls, credential rotation, and publishing/deployment.
- Visual redesign of sections before Contact or changes to the existing Contact card grid.

## Assumptions
- Plesk/Passenger Node is the durable production target; Vercel compatibility must share validation/error behavior but cannot promise local SQLite persistence.
- Existing `users.status`, `must_change_password`, and `sessions.state` are sufficient for a derived account-state model.
- No secret-bearing local file is read; secret/release checks operate on names, metadata, placeholders, and redacted pattern matches.

## Open questions
- None blocking local remediation; infrastructure-only requirements will be documented as conditions.
