# Deployment

## Configuration

Run `npm run prepare:production` first: it generates `APP_SECRET`, `GATE_SECRET`
and `ADMIN_SECRET_PATH`, prints a ready-to-paste block for the hosting panel, and
validates the resulting configuration with the same code that decides whether the
process may start. Re-run it as `npm run prepare:production -- --check` inside the
target environment to confirm the values before the first boot; it exits non-zero
when the configuration would be rejected.

Start from `.env.example` and set production values in the hosting control plane,
not in a file inside the release. Required values are `APP_SECRET`, `GATE_SECRET`,
`ADMIN_SECRET_PATH`, `PUBLIC_ORIGIN`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `DATA_DIR`, and `TRUSTED_PROXY_CIDRS`. The two secrets must
be independent random values of at least 32 characters. `ADMIN_SECRET_PATH` is a
random lowercase path of at least 24 characters.

Two more values are not required by the startup check but decide whether the
deployment behaves as intended:

- `ANALYTICS_ENABLED=1` — **defaults to off.** Without it the Metrica counter is
  stripped from every response and the CSP names no Yandex domain, so the site
  collects nothing. Nothing in the interface reveals this; it just reads as zero
  visits.
- `HSTS_MAX_AGE=300` for the first deploy. The default is one year, and a year
  cannot be taken back from a browser that already received it — if the
  certificate turns out to be wrong, those visitors are locked out. Raise it only
  after TLS and its auto-renewal are proven (see the ramp below).

`PUBLIC_ORIGIN` is always allowed for the public lead form.
`ALLOWED_ORIGINS` only adds normalized origins; it does not replace the primary
origin and never enables a credentialed wildcard.

## Reverse proxy and canonical IP

The supported topology is:

```text
browser -> trusted nginx/Passenger proxy -> Node process
```

**Under Plesk/Passenger the Node process is never directly exposed**, so
`TRUSTED_PROXY_CIDRS` must be set — normally to `127.0.0.1/32,::1/128`. List only
the CIDR of the immediate proxy that overwrites `X-Forwarded-For` and
`X-Real-IP`. The server trusts forwarding headers only when the TCP peer is in
this list and walks the forwarded chain from the trusted edge. Do not add public
networks or client ranges.

Production refuses to start when the value is missing. That is deliberate: an
empty list means "trust only the socket address", and behind a proxy the socket
address is the proxy, so every visitor collapses into one identity. The failures
that follow are all silent — the lead rate limit becomes a single global budget,
and the first scanner to hit a honeypot path such as `/.env` blocks that shared
hash for 24 hours, after which **the whole site answers every visitor with the
blank 404 shell**. If the process really is exposed directly, declare it:

```text
TRUSTED_PROXY_CIDRS=none
```

Verify after deploying: two requests from different networks must produce
different behaviour under the lead rate limit. If a single client can exhaust
the limit for everyone, the value is wrong.

The resulting canonical IP and its keyed hash are shared by rate limiting,
blocklists, leads, audit, and security events. IPv4, IPv6, malformed chains, and
untrusted spoofed headers are covered by tests.

Recommended proxy controls:

- overwrite, do not append, incoming forwarding headers;
- terminate TLS and redirect HTTP to the exact `PUBLIC_ORIGIN`;
- preserve `Host` and set request/body timeouts no longer than the application;
- keep `DATA_DIR` outside the public document root;
- do not log cookies, authorization values, request bodies, or secret URLs.

## First deploy and upgrade

1. Verify `node --version` and the release archive with
   `node scripts/verify-release.mjs <archive>`.
2. Extract into a new, empty version directory.
3. Configure the external `DATA_DIR`.
4. Back up the existing database and media directory before an upgrade.
5. Run `npm ci --omit=dev` (the runtime package currently has no npm dependencies).
6. On a first deploy, run `node scripts/seed-content.mjs --dry-run`, then
   `node scripts/seed-content.mjs`.
7. Start `node app.cjs`; migrations run before the listener accepts traffic.
8. Verify `/`, an unknown URL (must be 404), the secret admin shell, login,
   role authorization, and a lead through a Telegram mock or designated test chat.
   `npm run smoke:telegram` covers the lead path end to end before the deploy.
9. With `ANALYTICS_ENABLED=1`, confirm in the browser Network tab that the public
   page loads `mc.yandex.ru` and that the admin shell does **not**. The counter is
   served only by `sendPublicShell()`; a request to Yandex from the admin page
   means the secret path is leaking into analytics reports.
10. Switch the proxy/symlink to the new version. Keep the previous version for rollback.
11. **Connect the Telegram status buttons.** In the admin panel open
    Settings → "Подключить кнопки статуса". This calls `setWebhook` and is the
    only thing that makes the inline keyboard work; skip it and the CRM ships
    dead, with no error anywhere. It requires DNS and TLS to be live, because
    Telegram delivers only to an https URL — so it belongs after step 10, not
    before. Then send one test lead and press a status button in the sales chat:
    the card must redraw with the checkmark moved.
12. **Verify the live site:**

    ```sh
    TELEGRAM_BOT_TOKEN=<token> node scripts/verify-live.mjs https://www.prohvac.uz
    ```

    This is the only check that exercises the real process with the real
    variables on the real domain — everything else in this repository runs
    locally against throwaway configuration. It is read-only: it sends no lead
    and posts nothing to the chat. With the bot token present it also asks
    Telegram whether the webhook is registered and whether its delivery queue is
    draining, which is the single assertion that catches both a forgotten
    step 11 and a misconfigured `TRUSTED_PROXY_CIDRS`.

Never overlay a release onto an unknown live tree and never recursively delete
the current document root. Runtime data is external and must survive code rollback.

## Continuous deployment

`.github/workflows/deploy.yml` performs the steps above on every push to `main`.
Two jobs, deliberately split: `verify` runs lint, tests and every smoke script
and produces the release archive; `deploy` ships it. The deploy key lives in the
`production` GitHub environment, so it is out of reach while third-party build
tooling — vite, eslint, vitest and their transitive dependencies — is executing.

Four environment secrets are required: `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`. Host verification is on
(`StrictHostKeyChecking yes`), so a changed server key stops the deploy instead
of trusting it.

On the server the workflow is constrained by the Plesk chroot, which has no
`node`, `git`, `find`, `sort` or `sha256sum`. This shapes three decisions worth
knowing before editing the remote script:

- **`scp -O`.** OpenSSH 9 defaults to SFTP and the chroot has no `sftp-server`;
  the legacy protocol uses `/bin/scp`, which does exist.
- **Integrity is checked twice, differently.** The runner verifies the archive
  against the manifest hashes; the server can only compare the exact byte count
  and the gzip CRC, because there is no `sha256sum` in the chroot.
- **Pruning relies on lexical glob order.** Release ids start with a UTC
  timestamp precisely so `*/` expands oldest-first without `sort`. The release
  `current` points at is always skipped, so a rollback survives the next deploy.

Extraction lands in `releases/.staging-<id>` and is moved into place in one
rename, so `releases/<id>` is either absent or complete. `current` is a
*relative* symlink: the deploying shell is chrooted and Passenger is not, so an
absolute path written here would be dangling on the other side. Restart is
`touch current/tmp/restart.txt` — the chroot has neither systemd nor the Plesk
CLI, and Passenger re-execs on the next request after that file changes.

The last step is `scripts/verify-live.mjs` against the real domain. Set the
repository variable `AUTO_ROLLBACK=1` to have a failed verification flip the
symlink back automatically; without it the job prints the manual rollback
commands and stops.

`data/` and `production.env` are never touched by any of this. Database, media
and the copy of the panel variables outlive every release.

That exclusion has a first-deploy consequence worth stating plainly: **the media
library does not arrive with the code.** A pre-baked database references images
by content hash, and if the files were never copied into `DATA_DIR/media` the
site answers 200 everywhere, the deploy is green, and the pages simply render
empty frames where the photographs belong. Copy the directory once, next to the
database:

```sh
scp -O data/media/* <user>@<host>:/prohvac/data/media/
```

`scripts/verify-live.mjs` now asserts that every `/media/…` reference in
`/api/site/content` actually serves an image, so a missing library fails the
deploy instead of reaching visitors.

## HSTS ramp

`Strict-Transport-Security` is the one header a mistake in cannot be withdrawn:
a browser that received `max-age=31536000` will refuse plain HTTP to the domain
for a year, and lowering the value afterwards only reaches visitors who come back
*and* complete a successful HTTPS handshake first.

1. First deploy: `HSTS_MAX_AGE=300`.
2. After confirming the certificate chain is complete and auto-renewal works:
   `HSTS_MAX_AGE=86400`.
3. After a week without certificate problems: `HSTS_MAX_AGE=31536000`.

Leave `HSTS_INCLUDE_SUBDOMAINS` and `HSTS_PRELOAD` off unless every subdomain of
the apex — including third-party and staging hosts — is HTTPS. Preload entries
are compiled into browsers and take months to remove.

## Media storage

Uploads are content-sniffed JPEG, PNG, WebP, or AVIF images. The backend returns
the authoritative file-size, extension, dimension, and remaining-quota
capabilities. Writes use unique temporary files, transactional quota reservation,
content hashes, rollback, and reconciliation/GC. Use local durable storage with
the same owner and permissions as the Node process.
