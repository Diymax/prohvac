-- CR-035: pending TOTP enrollment kept apart from the active second factor.
--
-- Enrollment used to write the new secret straight into `totp_secrets` with
-- `confirmed_at = NULL`. Because the confirmed factor is exactly the row with a
-- non-NULL `confirmed_at`, that single UPSERT destroyed the working factor
-- *before* the replacement code was ever verified: an abandoned rebind (closed
-- tab, wrong app, phone that never stored the entry) left the account with a
-- password and nothing else, and the old authenticator entry was already
-- unusable. The candidate secret now lives here until it is confirmed, so
-- `totp_secrets` never holds anything but the factor that actually works.
--
-- Binding is (user, setup session), not (user): two browsers may legitimately
-- start enrollment at once, and the confirmation must activate the secret that
-- the confirming session was shown — never the one another session scanned.

CREATE TABLE IF NOT EXISTS totp_pending (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE is the whole cleanup story: a pending secret cannot
  -- outlive the session that started it, and session GC already removes those
  -- rows on its own schedule.
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
                             CHECK (length(session_id) = 64),
  -- Same three-column secretbox layout as totp_secrets: a dump without
  -- APP_SECRET must not reveal a candidate secret either.
  secret_ct  BLOB    NOT NULL,
  secret_iv  BLOB    NOT NULL CHECK (length(secret_iv) = 12),
  secret_tag BLOB    NOT NULL CHECK (length(secret_tag) = 16),
  digits     INTEGER NOT NULL DEFAULT 6 CHECK (digits IN (6, 8)),
  period     INTEGER NOT NULL DEFAULT 30 CHECK (period BETWEEN 15 AND 120),
  algorithm  TEXT    NOT NULL DEFAULT 'SHA1'
                             CHECK (algorithm IN ('SHA1', 'SHA256', 'SHA512')),
  created_at INTEGER NOT NULL,
  -- Hard deadline for the candidate, independent of the session idle window:
  -- a secret shown on screen and then forgotten must stop being confirmable
  -- even if the session itself is kept alive by other requests.
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  UNIQUE (user_id, session_id)
) STRICT;

-- Leftovers of the old flow. An unconfirmed row in totp_secrets is, by the
-- invariant of server/routes/admin.2fa.js, a factor that does not exist: login
-- ignores it and nothing can promote it any more. Dropping it here keeps the
-- table's meaning exact — every remaining row is a working factor.
DELETE FROM totp_secrets WHERE confirmed_at IS NULL;
