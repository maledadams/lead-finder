-- ---------------------------------------------------------------------------
-- Bounces and edited drafts.
--
-- A bounce is not a rejection. It means the address was wrong, so the business
-- itself is still worth contacting the moment a real address turns up. The
-- mechanism that makes that work already exists and needs no new state:
--
--   pipeline.js  contact_email = COALESCE(contact_email, ?)  -- only fills NULL
--   queue.js     if (!e.contact_email) continue;             -- NULL = unqueueable
--
-- So markBounced() nulls the address and parks the dead one in `suppressions`.
-- The lead leaves the roster immediately and returns by itself after a re-crawl
-- finds a different address. Deliberately NOT routed through suppress(), which
-- would set DO_NOT_CONTACT and make the removal permanent.
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent — running this twice errors.
-- Same as 003. Apply once:
--   npx wrangler d1 execute lead-finder --remote --file=./migrations/004_bounce_and_edit.sql
-- ---------------------------------------------------------------------------

ALTER TABLE outreach ADD COLUMN bounced_at TEXT;
ALTER TABLE outreach ADD COLUMN edited_at  TEXT;

-- The history pages read by status, newest first. Without these both are a
-- table scan; at 30 sends a day that is survivable but pointless to leave.
CREATE INDEX IF NOT EXISTS idx_outreach_status_sent    ON outreach(status, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_status_created ON outreach(status, created_at DESC);

-- The skipped page joins feedback to recover the reason, which is not stored
-- on the outreach row itself.
CREATE INDEX IF NOT EXISTS idx_feedback_outreach ON feedback(outreach_id);
