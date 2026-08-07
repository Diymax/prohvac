-- Durable Telegram delivery state and idempotency.
--
-- `leads.telegram_status` remains for backward compatibility with older
-- releases. `delivery_state` and `lead_delivery_attempts` are authoritative.

ALTER TABLE leads ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (delivery_state IN ('pending', 'sending', 'sent', 'failed', 'delivery_unknown'));

UPDATE leads
   SET delivery_state = CASE telegram_status
     WHEN 'sent' THEN 'sent'
     WHEN 'failed' THEN 'failed'
     WHEN 'skipped' THEN 'failed'
     ELSE 'pending'
   END;

CREATE TABLE lead_delivery_attempts (
  id                  INTEGER PRIMARY KEY,
  lead_id             INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  attempt_no          INTEGER NOT NULL CHECK (attempt_no > 0),
  state               TEXT    NOT NULL CHECK (
                              state IN ('pending', 'sending', 'sent', 'failed', 'delivery_unknown')
                            ),
  started_at          INTEGER,
  finished_at         INTEGER,
  response_code       INTEGER,
  safe_error          TEXT    CHECK (safe_error IS NULL OR length(safe_error) <= 200),
  telegram_message_id INTEGER,
  idempotency_key     TEXT    NOT NULL UNIQUE
                              CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  actor_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (lead_id, attempt_no),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
) STRICT;

CREATE UNIQUE INDEX lead_delivery_one_active_idx
  ON lead_delivery_attempts (lead_id)
  WHERE state IN ('pending', 'sending');

CREATE INDEX lead_delivery_state_idx
  ON lead_delivery_attempts (state, created_at DESC);

CREATE INDEX lead_delivery_lead_idx
  ON lead_delivery_attempts (lead_id, attempt_no DESC);

INSERT INTO lead_delivery_attempts (
  lead_id, attempt_no, state, started_at, finished_at, response_code,
  safe_error, telegram_message_id, idempotency_key, created_at
)
SELECT
  id,
  1,
  delivery_state,
  created_at,
  CASE WHEN delivery_state IN ('sent', 'failed') THEN created_at ELSE NULL END,
  NULL,
  CASE WHEN telegram_status = 'skipped' THEN 'legacy_skipped' ELSE telegram_error END,
  telegram_message_id,
  'legacy:' || id,
  created_at
FROM leads;
