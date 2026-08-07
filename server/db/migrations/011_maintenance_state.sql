-- CR-043: explicit maintenance lease and outcome state.
--
-- The scheduler used to live in a single `app_state` row, `last_purge_at`,
-- which was overwritten by the claim itself — before any work happened. That
-- one value had to answer three different questions at once: "who is running
-- right now", "when did a pass last succeed" and "when may the next pass
-- start". It could not, and the failure mode was the worst of the three: a
-- process that died one line after the claim had already published "the pass
-- happened", so every process in the pool stayed silent for the next 24 hours
-- and `leads.purge_after` — a declared personal-data retention deadline —
-- simply did not arrive.
--
-- Splitting the row fixes that by construction. The lease (owner, token,
-- deadline) says who holds the work; `next_run_at` says when the work becomes
-- claimable again and is written twice — once at claim time with a short
-- crash-retry horizon, once at completion with the real schedule. A crash in
-- between therefore costs one lease, not one day. The outcome columns
-- (success, failure, category, duration) are history, never scheduling input,
-- so the operations dashboard can report what happened without inferring it
-- from a timestamp that means something else.

CREATE TABLE IF NOT EXISTS maintenance_state (
  -- Named task, one row each: the batched purge and the SQLite compaction are
  -- scheduled and leased independently, because a checkpoint that cannot run
  -- (another process holds the WAL) must not postpone the deletion of expired
  -- personal data.
  task             TEXT    PRIMARY KEY CHECK (task IN ('purge', 'compact')),

  -- Who holds the work. The token is what makes completion safe: a process
  -- that stalled past its lease and woke up afterwards writes with a token the
  -- row no longer carries, so its late result is discarded instead of
  -- overwriting the pass that replaced it.
  lease_owner      TEXT    CHECK (lease_owner IS NULL OR length(lease_owner) <= 100),
  lease_token      TEXT    CHECK (lease_token IS NULL OR length(lease_token) <= 100),
  -- 0 means "no live lease". Kept NOT NULL so the claim predicate is a plain
  -- comparison and never has to reason about NULL.
  lease_until      INTEGER NOT NULL DEFAULT 0,
  -- When the current (or last) attempt started. Duration is measured on a
  -- monotonic clock instead, because wall time can step backwards.
  started_at       INTEGER,

  -- The only scheduling input. Success moves it a full interval ahead, failure
  -- a bounded backoff, and the claim itself moves it to the lease deadline so
  -- an unfinished pass is retried rather than forgotten.
  next_run_at      INTEGER NOT NULL DEFAULT 0,

  -- Outcome history. Success and failure are separate columns on purpose: a
  -- single "last run" timestamp cannot distinguish "cleaned up an hour ago"
  -- from "has been failing for a week".
  last_success_at  INTEGER,
  last_failure_at  INTEGER,
  failure_category TEXT    CHECK (failure_category IS NULL OR length(failure_category) <= 40),
  failure_streak   INTEGER NOT NULL DEFAULT 0 CHECK (failure_streak >= 0),
  last_duration_ms INTEGER CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
  -- Whether the last pass stopped on its time budget with work still pending.
  last_truncated   INTEGER NOT NULL DEFAULT 0 CHECK (last_truncated IN (0, 1)),

  updated_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT, WITHOUT ROWID;

-- Carry the legacy schedule over so an upgrade does not run a full purge on
-- the first tick after deployment. The old value was written at claim time, so
-- treating it as a success timestamp is optimistic by at most one pass — and
-- the next pass is a day away either way. A non-numeric leftover casts to 0
-- and is skipped: a corrupted marker means "never ran", not "ran in 1970".
INSERT INTO maintenance_state (task, next_run_at, last_success_at, updated_at)
SELECT 'purge',
       CAST(value AS INTEGER) + 86400000,
       CAST(value AS INTEGER),
       CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM app_state
 WHERE key = 'last_purge_at'
   AND CAST(value AS INTEGER) > 0
    ON CONFLICT (task) DO NOTHING;
