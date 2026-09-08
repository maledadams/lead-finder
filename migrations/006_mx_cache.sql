-- ---------------------------------------------------------------------------
-- mx_cache — does this domain accept mail at all?
--
-- Six addresses in the bounce log were on domains that do not exist
-- (antik.brooklyn, ivity.get, checkout.duties). Every one of those bounces was
-- avoidable by asking a DNS server before sending, and every one cost sending
-- reputation that is slow to earn back.
--
-- The answer is cached because it rarely changes and the check sits on the send
-- path, where an extra round trip per message would be paid forever.
--
-- NOTE: safe to re-run — this migration only creates.
--   npx wrangler d1 execute lead-finder --remote --file=./migrations/006_mx_cache.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mx_cache (
  domain      TEXT PRIMARY KEY,
  deliverable INTEGER NOT NULL,      -- 1 | 0
  detail      TEXT,                  -- mx:2 | nxdomain | implicit-mx:a | ...
  checked_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mx_checked ON mx_cache(checked_at);
