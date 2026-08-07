-- CR-039 / CR-040: per-job claims for the translation worker and transactional
-- quota reservations.
--
-- CR-039. The worker leased the whole queue once per tick with a fixed TTL and
-- never renewed it. A tick longer than the TTL let a second worker take the
-- lease while the first was still inside a provider call, and both then wrote
-- results for the same rows. `status = 'running'` alone cannot tell "mine" from
-- "someone else's", so a claim needs an owner, a random token and an explicit
-- deadline. Recovery keys off that deadline instead of `updated_at`, which is
-- bumped by unrelated writes and says nothing about whether the claim is alive.
--
-- CR-040. `preflight -> provider call -> usage.add` is three steps with two
-- await points in between. Two workers could both pass preflight against the
-- same remaining quota and both send, so a hard monthly limit was breakable by
-- exactly the number of processes in the pool. A reservation makes the decision
-- and the accounting one atomic step: characters are held before the request is
-- issued and converted to real usage only after the provider answered.

ALTER TABLE translation_jobs ADD COLUMN claim_owner TEXT;

ALTER TABLE translation_jobs ADD COLUMN claim_token TEXT;

-- 0 means "no claim": rows claimed before this migration keep it and stay
-- reachable through the legacy `updated_at` branch of recovery.
ALTER TABLE translation_jobs ADD COLUMN claim_until INTEGER NOT NULL DEFAULT 0;

-- Recovery scans expired claims only. Without the partial index the scan reads
-- every historical `done`/`failed`/`skipped` row on every tick.
CREATE INDEX translation_jobs_claim_expiry_idx
  ON translation_jobs (claim_until)
  WHERE status = 'running';

-- Characters promised to a provider but not yet accounted as spent.
--
-- The row is the unit of atomicity: it is inserted in the same transaction that
-- checks the remaining quota, so a competing worker either sees it and backs
-- off, or wins and the loser sees its row. `expires_at` bounds the damage of a
-- process that dies between the insert and the settlement — the hold is
-- reclaimed instead of shrinking the quota until the month rolls over.
CREATE TABLE IF NOT EXISTS translation_quota_reservations (
  id         INTEGER PRIMARY KEY,
  provider   TEXT    NOT NULL,
  -- UTC month key, the same partition the local usage counter uses.
  month      TEXT    NOT NULL,
  -- Estimated characters at reservation time; overwritten with the billed
  -- amount when the reservation is committed.
  chars      INTEGER NOT NULL CHECK (chars >= 0),
  owner      TEXT    NOT NULL,
  token      TEXT    NOT NULL UNIQUE,
  state      TEXT    NOT NULL DEFAULT 'held'
                     CHECK (state IN ('held', 'committed', 'released')),
  -- Why the hold ended: 'billed', 'expired', 'pre_send_failure', 'lease_lost'.
  reason     TEXT    CHECK (reason IS NULL OR length(reason) <= 60),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT;

-- The hot query is "sum of live holds for this provider and month", and the
-- reclaim pass needs the expired ones out of the same partition.
CREATE INDEX translation_quota_held_idx
  ON translation_quota_reservations (provider, month, expires_at)
  WHERE state = 'held';
