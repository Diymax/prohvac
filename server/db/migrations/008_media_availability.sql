-- CR-037 / CR-034: an explicit availability state for media rows.
--
-- CR-037. The garbage collector used to delete the media row no matter how the
-- unlink went (`server/routes/admin.media.js`: `try { await unlink(...) } catch {}`
-- followed by an unconditional `DELETE FROM media`). An `EACCES`, `EPERM` or
-- `EBUSY` failure therefore threw away the only reference to a file that stayed
-- on disk and kept occupying the 500 MB quota forever. Keeping the row requires
-- somewhere to record why the unlink failed and when it may be retried.
--
-- CR-034. Restore used to clear `deleted_at` before checking the quota and
-- before checking that the file still exists, so it could activate a row with
-- no file behind it. Telling "soft-deleted on purpose" apart from "the file
-- vanished" needs a state that `deleted_at` alone cannot express.
--
-- Why `missing` rows also carry `deleted_at`: every public content query gates
-- publication on `m.deleted_at IS NULL` (server/routes/public.content.js). A row
-- whose file is gone must stop being published through that same gate, so
-- reconciliation sets both columns. `availability` is what keeps the two cases
-- distinguishable for the admin UI and for the restore path.

ALTER TABLE media ADD COLUMN availability TEXT NOT NULL DEFAULT 'available'
  CHECK (availability IN ('available', 'missing', 'pending_delete', 'deleted'));

-- Retry metadata for a unlink that failed with something other than ENOENT.
-- Without a retry gate a permanently locked file would be re-attempted on every
-- pass, and the warning it produces would drown the operations log.
ALTER TABLE media ADD COLUMN unlink_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (unlink_attempts >= 0);

ALTER TABLE media ADD COLUMN unlink_error TEXT
  CHECK (unlink_error IS NULL OR length(unlink_error) <= 200);

ALTER TABLE media ADD COLUMN unlink_retry_after INTEGER;

-- When reconciliation last confirmed the state of the file on disk.
ALTER TABLE media ADD COLUMN availability_checked_at INTEGER;

-- Existing soft-deleted rows are awaiting collection by definition.
UPDATE media SET availability = 'pending_delete' WHERE deleted_at IS NOT NULL;

-- The admin library reads the problem rows separately from the live ones, and
-- the collector scans by retry deadline. Both predicates select a small
-- minority of rows, so a partial index keeps the live listing untouched.
CREATE INDEX IF NOT EXISTS media_problem_idx
  ON media (availability, unlink_retry_after)
  WHERE availability <> 'available';
