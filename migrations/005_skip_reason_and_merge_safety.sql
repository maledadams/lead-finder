-- ---------------------------------------------------------------------------
-- Two bugs that both destroyed information.
--
-- 1. Skipping a lead overwrote entities.score_reason with the reviewer's note,
--    permanently losing the model's explanation for the score — the very thing
--    you read to decide whether the score can be trusted. Two unrelated pieces
--    of information were sharing one column and the less important one won.
--    The skip note gets its own column here.
--
-- 2. Merging two entities deleted whichever outreach row lost a collision on
--    (entity_id, queue_date), without looking at its status. If the deleted row
--    was SENT, the record that an email actually reached that business was
--    gone — and sent history is the one thing in this system that cannot be
--    reconstructed.
--
--    The real fault was the index, not the merge. It exists to stop the queue
--    drafting the same business twice in a day, but as written it also forbids
--    two historical rows from coexisting, which is what forced a delete. Made
--    partial, it says exactly what it means: one DRAFT per business per day.
--    Sent, skipped and bounced rows are records of things that happened and
--    may sit alongside each other freely.
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent — running this twice errors.
--   npx wrangler d1 execute lead-finder --remote --file=./migrations/005_skip_reason_and_merge_safety.sql
-- ---------------------------------------------------------------------------

ALTER TABLE entities ADD COLUMN skip_reason TEXT;

DROP INDEX IF EXISTS idx_outreach_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_unique
  ON outreach(entity_id, queue_date) WHERE status = 'DRAFT';
