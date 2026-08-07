# Operations

## Backups and restore

Use the CLI backup command while the application can reach the same `DATA_DIR`:

```bash
node scripts/admin-cli.mjs backup --out <explicit-backup-path>
```

**Nothing schedules this.** The command exists, the application never calls it,
and until a cron entry is created there are no backups at all. Set one up as part
of the first deploy, not after the first incident:

```cron
# 03:20 daily: database snapshot outside DATA_DIR, plus the media tree.
20 3 * * * cd /path/to/current && /usr/bin/node scripts/admin-cli.mjs backup \
  --out /backups/prohvac/app-$(date +\%F).sqlite.gz
40 3 * * * tar -czf /backups/prohvac/media-$(date +\%F).tar.gz -C /path/to/data media
# Keep 30 days. Without this the 500 MB plan fills up and writes start failing.
50 3 * * * find /backups/prohvac -name '*.gz' -mtime +30 -delete
```

Three details that matter:

- **Write outside `DATA_DIR`.** The default destination is `DATA_DIR/backups`,
  which is the directory a disk failure or a mistaken `rm -rf` destroys along
  with the original. Always pass `--out`.
- **Media is not in the database backup.** `backup` snapshots SQLite only.
  Restoring the database alone leaves rows pointing at files that no longer
  exist.
- **Rotation is not automatic.** Nothing prunes old archives.

Restoring requires the same `APP_SECRET`: without it the encrypted settings —
including the bot token — cannot be read. Store it with the backups, separately.

Test restores periodically. For restore, stop writers, preserve the failed data
directory, restore the SQLite database plus matching media snapshot into a new
explicit directory, run the application migration smoke, then switch `DATA_DIR`.
Do not copy only `app.sqlite` while ignoring active `-wal`/`-shm` files.

## Migrations

Migration files are append-only and execute in filename order inside
transactions. Never edit a migration already applied in production; add the
next numbered file. `npm run smoke:migrations` verifies both a fresh database
and upgrade from the original schema.

## Lead delivery states

- `pending`: accepted locally, delivery has not started;
- `sending`: one process owns the attempt;
- `sent`: Telegram confirmed receipt and its message ID was recorded;
- `failed`: Telegram explicitly failed before confirmation; retry may be offered;
- `delivery_unknown`: Telegram confirmed or may have accepted the message, but
  durable local confirmation is uncertain.

Each attempt stores a number, timestamps, safe result/error metadata, Telegram
message ID when available, and an idempotency key. `delivery_unknown` is never
retried automatically; an administrator must explicitly confirm the risk of a
duplicate. Concurrent retry/double-click requests share the durable claim.

Rejected Origin, method, content type, body size, rate limit, validation, or
missing-delivery-configuration requests create neither a lead nor a delivery attempt.

### Recovering a stranded attempt

Telegram can accept a message and both local writes can then fail — the `sent`
write and the follow-up `delivery_unknown` write. The durable attempt is left in
`sending`, and because a partial unique index allows only one active attempt per
lead, retry answers `delivery_in_progress` forever.

`server/application/delivery-recovery.js` closes that hole. A `sending` attempt
older than the TTL (five minutes by default) is moved to `delivery_unknown` —
never to `failed`, because the external system may well have delivered it. The
update is conditional, so an attempt that reached a terminal state in the
meantime is left alone, and a lease in `app_state` keeps two processes from
performing the transition twice.

Recovery runs at startup, on every 60-second tick, and immediately before an
operator resend. Recovered attempts carry `recovered_at` and `recovery_reason`,
and the operations dashboard reports them separately from ordinary
non-delivery under `delivery_recovered_unknown`. Confirm the Telegram chat
before approving a retry: the whole point of `delivery_unknown` is that the
message may already be there.

### Submission idempotency

The public form sends an `Idempotency-Key` (UUID v4) held in `sessionStorage`
and bound to a digest of the significant form fields. The server stores a
SHA-256 fingerprint of the canonical payload alongside the key:

- same key, same fingerprint — the stored result is replayed and Telegram is
  not called again;
- same key, different fingerprint — `409 idempotency_conflict`;
- malformed or low-entropy key — `400`.

Idempotency records have no separate lifetime; they are removed with the lead at
`purge_after` (365 days).

## Telegram and DeepL

Telegram credentials can come from the production environment and may be
overridden by encrypted settings. Both token and chat ID plus enabled state are
required before a lead is persisted. The operational dashboard reports only
ready/not-ready, never credentials.

DeepL uses the canonical `deepl.api_key` registry entry. The encrypted stored
setting has precedence; environment fallback is used only when the stored entry
is absent. A partial/corrupt ciphertext is treated as unavailable, emits an
operational warning, and never falls back silently.

Translation routing is an ordered provider array per language. An explicit empty
array disables translation for that language. Worker leases and unique pending
jobs prevent two processes from performing the same task.

## Troubleshooting

The dashboard shows role-permitted aggregates for failed/unknown delivery,
Telegram readiness, translation queue/failures, last successful translation,
media quota, filesystem space, worker/runtime state, IP blocks, and denied audit
activity. Follow the card link to the owning section.

Client errors show a human message, recommended action, safe technical code, and
request ID separately. Search server/proxy logs by request ID; never ask users
to send tokens, passwords, recovery codes, or full request bodies.

Common conditions:

- `must_change_password`: complete password change; other admin APIs are blocked.
- `not_configured`: configure the named integration and use its safe test action.
- `delivery_unknown`: inspect Telegram before explicitly retrying.
- `payload_too_large` / `unsupported_media_type`: use capabilities shown by UI.
- degraded content: restore SQLite; the server serves the last valid cached state
  without creating a false revision.

Maintenance removes expired leads and old media tombstones and reconciles missing
or orphaned files. Monitor the last successful maintenance/translation time and
free space. All timestamps are Unix epoch milliseconds.

## What runs by itself, and what does not

Runs automatically, no cron entry needed. An hourly lifecycle tick takes a lease
in `app_state`, so exactly one process in the Passenger pool acts:

- deletion of leads whose `purge_after` has arrived — the retention promise made
  to clients is kept without anyone's intervention;
- login attempts, IP blocks, finished translation jobs, audit log and the
  Telegram update ledger, each on its own retention;
- WAL checkpointing;
- the translation worker.

One caveat: the timers are `unref`'d and the first pass is delayed 30 seconds.
On a site with almost no traffic Passenger may recycle the process before the
hourly tick ever fires, so retention effectively depends on the site being
visited. If the panel shows the last successful maintenance was days ago, that is
why — a periodic external request to `/` is enough to fix it.

Requires a human or a cron entry:

- **backups** — see above;
- **media reconciliation and garbage collection** — `reconcileMediaStorage` has
  exactly one caller, the admin Media screen. Soft-deleted files keep occupying
  the quota until someone opens that screen or a cron entry runs
  `node scripts/admin-cli.mjs gc`.
