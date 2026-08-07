-- CR-032 / CR-033: recovery of stranded delivery attempts and a payload
-- fingerprint for end-to-end idempotency.
--
-- CR-032. When Telegram accepted a message but both the `sent` write and the
-- follow-up `delivery_unknown` write failed, the attempt stayed in `sending`
-- forever. The partial unique index `lead_delivery_one_active_idx` then blocked
-- every new attempt for that lead, so the lead could never be retried. A
-- recovery pass needs to find those rows by (state, started_at) and record why
-- it moved them, without ever downgrading a confirmed external success to
-- `failed`.
--
-- CR-033. `idempotency_key` alone is not a safe replay key: the same key sent
-- with a different payload used to return the previous submission's result.
-- The fingerprint is a hash of the canonical lead payload, so a mismatch can be
-- rejected as a conflict instead of silently answering for another lead.

ALTER TABLE lead_delivery_attempts ADD COLUMN recovered_at INTEGER;

ALTER TABLE lead_delivery_attempts ADD COLUMN recovery_reason TEXT
  CHECK (recovery_reason IS NULL OR length(recovery_reason) <= 100);

ALTER TABLE lead_delivery_attempts ADD COLUMN payload_fingerprint TEXT
  CHECK (payload_fingerprint IS NULL OR length(payload_fingerprint) = 64);

-- The recovery scan is `state = 'sending' AND started_at < ?`. The existing
-- `lead_delivery_state_idx` orders by created_at, which does not answer that
-- predicate without reading the whole state partition.
CREATE INDEX lead_delivery_stale_idx
  ON lead_delivery_attempts (state, started_at)
  WHERE state IN ('pending', 'sending');

-- Replaying an idempotent submission looks the row up by key and compares the
-- fingerprint; the key is already UNIQUE, so this index only serves the
-- fingerprint comparison for the conflict path.
CREATE INDEX lead_delivery_fingerprint_idx
  ON lead_delivery_attempts (idempotency_key, payload_fingerprint);
