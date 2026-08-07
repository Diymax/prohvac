-- CR-047: indexes for keyset pagination and filtered listing.
--
-- `leads_created_idx` covers only `created_at DESC`. The list is ordered by
-- `(created_at DESC, id DESC)` and the cursor predicate compares that exact
-- tuple, so SQLite could satisfy the ordering but still had to break ties by
-- reading the table. With equal timestamps — which is what a burst of
-- submissions produces — that is precisely the case where a page can repeat or
-- skip a row, so the index has to carry `id` as well.
CREATE INDEX IF NOT EXISTS leads_keyset_idx ON leads (created_at DESC, id DESC);

-- The status filter is the one operators use constantly ("new" first). Adding
-- `id` keeps the filtered listing on the same keyset order as the unfiltered
-- one instead of falling back to a sort.
CREATE INDEX IF NOT EXISTS leads_status_keyset_idx ON leads (status, created_at DESC, id DESC);

-- Delivery-state filtering backs the dashboard counters for failed and
-- delivery_unknown leads, which are read on every operations overview.
CREATE INDEX IF NOT EXISTS leads_delivery_state_idx
  ON leads (delivery_state, created_at DESC, id DESC);

-- Media listing moved off a hardcoded `LIMIT 500` to the same keyset scheme.
-- The partial predicate matches the live-media query so the index stays small.
CREATE INDEX IF NOT EXISTS media_keyset_idx
  ON media (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Filtering media by MIME type inside the live set.
CREATE INDEX IF NOT EXISTS media_mime_idx
  ON media (mime, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
