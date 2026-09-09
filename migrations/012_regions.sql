-- ---------------------------------------------------------------------------
-- Where to crawl, decided from the UI rather than from a file.
--
-- src/metros.js still holds 1,123 built-in US boxes and stays the fallback.
-- This table only ADDS to it and SUBTRACTS from it, so an empty table means
-- today's behaviour exactly.
--
-- ONE TABLE, TWO KINDS. kind='city' is somewhere to look; kind='block' is
-- somewhere never to look again, matched by name against both the built-in
-- boxes and the added ones. Two tables would mean two CRUD paths, two delete
-- paths and two scoping rules for what is one idea: places, and whether we go
-- there.
--
-- profile_id NULL means every profile. Geography is usually a decision about
-- the whole operation, not about one of them.
--
-- acknowledged_at is not decoration. CAN-SPAM covers the United States; the EU
-- is GDPR and Canada is CASL, which requires consent BEFORE sending and fines
-- per message. A country is not swept until someone has said they understand
-- that, and this column is the record that they did.
--
-- Safe to re-run.
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./migrations/012_regions.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS regions (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT,                     -- NULL = every profile
  kind            TEXT NOT NULL,            -- 'city' | 'block'
  country         TEXT NOT NULL DEFAULT 'US',
  name            TEXT NOT NULL,            -- how a person says it
  slug            TEXT NOT NULL,            -- the metro key the crawl uses
  bbox            TEXT,                     -- JSON [s,w,n,e]; NULL for a block
  priority        INTEGER NOT NULL DEFAULT 0,  -- higher is swept sooner
  active          INTEGER NOT NULL DEFAULT 1,
  source          TEXT,                     -- 'manual' | 'nominatim' | 'overpass'
  acknowledged_at TEXT,                     -- the compliance acknowledgement
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_regions_use  ON regions(kind, active, priority DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_slug ON regions(kind, COALESCE(profile_id, ''), slug);
