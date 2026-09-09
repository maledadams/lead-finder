-- ---------------------------------------------------------------------------
-- bounce_seen — which bounce notices have already been handled.
--
-- Zoho Mail cannot push, so the bounce label is polled on the cron that already
-- runs. Polling means seeing the same message repeatedly, and a message is
-- recorded here whether or not it could be attributed to a lead: an
-- unattributable notice must not be re-examined on every tick forever.
--
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./migrations/007_bounce_seen.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bounce_seen (
  message_id  TEXT PRIMARY KEY,     -- Zoho's message id
  outreach_id TEXT,                 -- null when it could not be attributed
  outcome     TEXT,                 -- bounced | unmatched | failed: ...
  seen_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bounce_seen_at ON bounce_seen(seen_at);
