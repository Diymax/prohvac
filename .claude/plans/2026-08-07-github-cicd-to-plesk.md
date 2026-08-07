# GitHub CI/CD to the Plesk host — ✅ DONE

Goal: a push to `main` builds, verifies and lands on prohvac.uz without a manual
step.

## Steps

1. ✅ Initialise the repository, confirm nothing secret is staged, push to a
   private `github.com/Diymax/prohvac`.
2. ✅ Generate a dedicated ed25519 key for the workstation push and register it
   on the account.
3. ✅ Create the `production` environment with `DEPLOY_HOST`, `DEPLOY_USER`,
   `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.
4. ✅ Author `.github/workflows/deploy.yml`: verify + build artifact, then a
   separate deploy job (upload → staged extract → symlink flip → restart →
   live verification, with optional rollback).
5. ✅ Fix what a clean clone exposed: `src/data/content.js` was excluded by an
   unanchored `data/` ignore rule, and `npm test` ran before `npm run build`
   although several suites serve `dist/index.html`.
6. ✅ Fix the workflow file itself: an inline `run:` containing a colon made the
   YAML unparseable and every deploy run failed before starting.
7. ✅ Make `verify-live.mjs` assert only what the application controls, so the
   platform's `X-Powered-By` banner and the hosting's default-vhost answer to a
   foreign `Host` stop failing a correct deploy.
8. ✅ Confirm end to end: `current -> releases/20260807T145839Z-843676a9579f`
   matches the pushed commit; live verification passes 23 checks, 0 failures.

## Left deliberately undone

- The `X-Powered-By: Phusion Passenger` banner. This plan's panel offers no
  "additional nginx directives" field, and the "additional headers" field can
  only set headers, not unset them — changing production Apache configuration to
  hide a version string is not worth the risk. Recorded as a warning instead.
- `TELEGRAM_BOT_TOKEN` as a CI secret, which would turn the webhook-registration
  warning into a real assertion. The current token appeared in chat and should
  be rotated first; adding it to CI beforehand would just spread it further.
