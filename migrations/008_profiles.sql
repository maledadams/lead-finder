-- ---------------------------------------------------------------------------
-- Profiles: separate outreach operations sharing one deployment.
--
-- Switching profile should feel like switching account. Leads, drafts, replies,
-- lessons, keywords, crawl frontier, spend and every metric belong to exactly
-- one profile and are never mixed. What IS shared is the plumbing: one Zoho
-- mailbox, one Cloudflare account, one database, one booking calendar.
--
-- DEDUP STAYS GLOBAL. entity_keys.key is left unique across the whole database
-- on purpose: a business belongs to whichever profile discovered it first, and
-- every other profile skips it. That is what stops one person receiving two
-- different pitches from the same sender, which is the worst thing this system
-- could do to a reputation.
--
-- FOUR TABLES ARE REBUILT rather than altered, because their primary key has to
-- widen and SQLite cannot alter one in place.
--
-- Every existing row is assigned to the profile that already owned it, which is
-- the only one that has ever run.
--
-- Safe to re-run except the ALTER TABLE lines, as with every migration here.
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./migrations/008_profiles.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,        -- url-safe, used in links
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,  -- which one loads first

  -- The brief a person wrote, in their own words. Everything below is derived
  -- from it, and it is kept so a profile can be regenerated or refined later.
  brief       TEXT,

  -- Generated configuration. JSON, because its shape is per-profile and the
  -- alternative is a table per concept.
  ai_system   TEXT,   -- the scoring brief the model is judged against
  niches      TEXT,   -- {slug: {label, keywords[], signals[]}}
  personas    TEXT,   -- {niche: {label, subject, context}}
  seed_keywords TEXT, -- [] bootstrap terms for discovery
  metros      TEXT,   -- [] where to look, when it is a local business
  budgets     TEXT,   -- {fetch, ai, source, browser} per day, for this profile
  discovery   TEXT,   -- {osm:{shop,craft,amenity,healthcare,office},exclude,metros}

  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(active, is_default);

-- --- plain additions -------------------------------------------------------

ALTER TABLE entities       ADD COLUMN profile_id TEXT;
ALTER TABLE outreach       ADD COLUMN profile_id TEXT;
ALTER TABLE feedback       ADD COLUMN profile_id TEXT;
ALTER TABLE lessons        ADD COLUMN profile_id TEXT;
ALTER TABLE runs           ADD COLUMN profile_id TEXT;
ALTER TABLE snapshots      ADD COLUMN profile_id TEXT;
ALTER TABLE evaluations    ADD COLUMN profile_id TEXT;

-- --- the profile that already exists --------------------------------------

INSERT OR IGNORE INTO profiles
  (id, slug, name, active, is_default, brief, created_at, updated_at)
VALUES (
  'p-creative', 'creative', 'Creative & founder-led', 1, 1,
  'Independent, founder-led creative businesses in the US: alternative fashion, handmade and craft, beauty and skincare, food and drink, artist portfolios, creative studios and lifestyle brands. Small, expressive, personality-driven. Not corporate.',
  datetime('now'), datetime('now')
);

UPDATE entities    SET profile_id = 'p-creative' WHERE profile_id IS NULL;
UPDATE outreach    SET profile_id = 'p-creative' WHERE profile_id IS NULL;
UPDATE feedback    SET profile_id = 'p-creative' WHERE profile_id IS NULL;
UPDATE lessons     SET profile_id = 'p-creative' WHERE profile_id IS NULL;
UPDATE runs        SET profile_id = 'p-creative' WHERE profile_id IS NULL;
UPDATE snapshots   SET profile_id = 'p-creative' WHERE profile_id IS NULL;
UPDATE evaluations SET profile_id = 'p-creative' WHERE profile_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_entities_profile ON entities(profile_id, state);
CREATE INDEX IF NOT EXISTS idx_outreach_profile ON outreach(profile_id, queue_date);
CREATE INDEX IF NOT EXISTS idx_feedback_profile ON feedback(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lessons_profile  ON lessons(profile_id, active, weight DESC);

-- --- rebuilds: the primary key has to widen -------------------------------

CREATE TABLE IF NOT EXISTS crawl_frontier_v2 (
  profile_id    TEXT NOT NULL,
  url           TEXT NOT NULL,
  domain        TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,
  parent_entity TEXT,
  reason        TEXT,
  priority      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  added_at      TEXT NOT NULL,
  processed_at  TEXT,
  PRIMARY KEY (profile_id, url)
);
INSERT OR IGNORE INTO crawl_frontier_v2
  SELECT 'p-creative', url, domain, depth, parent_entity, reason, priority, status, added_at, processed_at
  FROM crawl_frontier;
DROP TABLE crawl_frontier;
ALTER TABLE crawl_frontier_v2 RENAME TO crawl_frontier;
CREATE INDEX IF NOT EXISTS idx_frontier_status ON crawl_frontier(profile_id, status, priority DESC, added_at);
CREATE INDEX IF NOT EXISTS idx_frontier_domain ON crawl_frontier(domain);

CREATE TABLE IF NOT EXISTS keywords_v2 (
  profile_id   TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  niche        TEXT,
  source       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'UNVALIDATED',
  certs_seen   INTEGER,
  domains_kept INTEGER NOT NULL DEFAULT 0,
  leads_found  INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  runs         INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (profile_id, keyword)
);
INSERT OR IGNORE INTO keywords_v2
  SELECT 'p-creative', keyword, niche, source, status, certs_seen, domains_kept,
         leads_found, last_run_at, runs, added_at FROM keywords;
DROP TABLE keywords;
ALTER TABLE keywords_v2 RENAME TO keywords;
CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(profile_id, status, last_run_at);
CREATE INDEX IF NOT EXISTS idx_keywords_niche  ON keywords(profile_id, niche);

CREATE TABLE IF NOT EXISTS source_cursor_v2 (
  profile_id  TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  last_run_at TEXT,
  total_found INTEGER NOT NULL DEFAULT 0,
  runs        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, keyword)
);
INSERT OR IGNORE INTO source_cursor_v2
  SELECT 'p-creative', keyword, last_run_at, total_found, runs FROM source_cursor;
DROP TABLE source_cursor;
ALTER TABLE source_cursor_v2 RENAME TO source_cursor;

-- Budget is per profile, so one profile's crawl cannot exhaust another's.
CREATE TABLE IF NOT EXISTS budget_v2 (
  profile_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  metric     TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, day, metric)
);
INSERT OR IGNORE INTO budget_v2 SELECT 'p-creative', day, metric, used FROM budget;
DROP TABLE budget;
ALTER TABLE budget_v2 RENAME TO budget;

-- --- what stays shared ----------------------------------------------------
--
-- suppressions: an opt-out is a person's wish, not a profile's preference. If
--   someone asks not to be written to, that holds across every profile.
-- mx_cache: a domain either accepts mail or does not. Nothing profile-specific.
-- app_settings, bounce_seen: one mailbox, one set of tokens, one bounce label.
-- The booking calendar, for the same reason.
