-- ===========================================================================
-- lead-finder schema
--
-- Two jobs, equally important:
--   1. Never surface the same business twice (entity-level dedup).
--   2. Never redo work that was already done (the DB is also a compute cache).
--
-- Safe to re-run: every statement is IF NOT EXISTS.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- entities — one row per real-world business or person, no matter how many
-- URLs, handles or shopfronts it turns up under.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id                 TEXT PRIMARY KEY,
  display_name       TEXT,
  founder_name       TEXT,
  website            TEXT,
  domain             TEXT,
  instagram          TEXT,
  tiktok             TEXT,
  etsy               TEXT,
  other_profiles     TEXT,             -- JSON array
  niche              TEXT,             -- taxonomy slug, see src/config.js
  location_text      TEXT,
  country            TEXT,
  contact_email      TEXT,
  contact_source     TEXT,             -- how we got the email, for honesty
  state              TEXT NOT NULL DEFAULT 'DISCOVERED',
  score              INTEGER,
  score_reason       TEXT,
  reject_reason      TEXT,
  website_opportunity TEXT,
  system_opportunity  TEXT,
  power_signals      TEXT,             -- JSON array
  creative_signals   TEXT,             -- JSON array
  personalization    TEXT,             -- JSON: {liked, evidence_url, opportunity}
  outreach_angle     TEXT,
  discovery_source   TEXT,
  discovered_via     TEXT,             -- parent entity id for link-graph finds
  first_seen_at      TEXT NOT NULL,
  last_evaluated_at  TEXT,
  first_contacted_at TEXT,
  last_contacted_at  TEXT,
  response_status    TEXT,
  client_status      TEXT,
  followup_status    TEXT,
  times_surfaced     INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  -- Added by migration 001. Repeated here so db:init produces the same table
  -- as a migrated one; the dashboard reads both phone and has_website, so a
  -- fresh database without them cannot render.
  phone              TEXT,
  osm_tags           TEXT,             -- JSON
  has_website        INTEGER           -- 1 | 0 | NULL (unknown)
);

-- state is the hot filter on every queue build.
CREATE INDEX IF NOT EXISTS idx_entities_state       ON entities(state);
CREATE INDEX IF NOT EXISTS idx_entities_score       ON entities(score DESC);
CREATE INDEX IF NOT EXISTS idx_entities_evaluated   ON entities(last_evaluated_at);
CREATE INDEX IF NOT EXISTS idx_entities_domain      ON entities(domain);
CREATE INDEX IF NOT EXISTS idx_entities_has_website ON entities(has_website);

-- ---------------------------------------------------------------------------
-- entity_keys — THE dedup index.
--
-- Every identifier we have ever seen for an entity becomes a row here. A new
-- candidate is resolved by looking up all of its normalized keys at once: any
-- hit means we already know this business. This is what stops the same brand
-- entering as four leads via site + Instagram + TikTok + Etsy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_keys (
  key        TEXT PRIMARY KEY,         -- e.g. "domain:cutebrand.com"
  kind       TEXT NOT NULL,            -- domain | instagram | tiktok | etsy | email | name
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_keys_entity ON entity_keys(entity_id);

-- ---------------------------------------------------------------------------
-- snapshots — the compute cache. One row per fetch of a URL.
--
-- content_hash lets us skip re-analysis when nothing changed, which is the
-- single biggest lever on Cloudflare consumption.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshots (
  id             TEXT PRIMARY KEY,
  entity_id      TEXT REFERENCES entities(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  http_status    INTEGER,
  ok             INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  content_hash   TEXT,
  bytes          INTEGER,
  ttfb_ms        INTEGER,
  signals        TEXT,                 -- JSON, see src/extract.js
  text_sample    TEXT,
  render_mode    TEXT                  -- static | browser (migration 002)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON snapshots(entity_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_url    ON snapshots(url);

-- ---------------------------------------------------------------------------
-- evaluations — cached AI judgements. Keyed by the content hash they were
-- made against, so an unchanged site never gets re-evaluated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evaluations (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content_hash  TEXT,
  model         TEXT,
  created_at    TEXT NOT NULL,
  result        TEXT NOT NULL,         -- JSON, see src/ai.js
  neurons_est   REAL
);

CREATE INDEX IF NOT EXISTS idx_evaluations_entity ON evaluations(entity_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluations_hash ON evaluations(entity_id, content_hash);

-- ---------------------------------------------------------------------------
-- crawl_frontier — link-graph expansion queue.
--
-- This is the discovery engine. Indie brands link to indie brands (stockists,
-- "brands we love", collabs, press). Following that graph propagates taste.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_frontier (
  url          TEXT PRIMARY KEY,
  domain       TEXT NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 0,
  parent_entity TEXT,
  reason       TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | DONE | SKIPPED | ERROR
  added_at     TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_frontier_status ON crawl_frontier(status, priority DESC, added_at);
CREATE INDEX IF NOT EXISTS idx_frontier_domain ON crawl_frontier(domain);

-- ---------------------------------------------------------------------------
-- outreach — drafts and send state. Separate from entity state so an entity
-- can be re-approached later as a follow-up without becoming a "new lead".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  queue_date   TEXT NOT NULL,
  rank         INTEGER,
  persona      TEXT,
  subject      TEXT,
  body         TEXT,
  cta          TEXT,
  status       TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | SENT | SKIPPED | BOUNCED
  is_followup  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  sent_at      TEXT,
  -- Added by migrations 003 and 004. Repeated here so that a fresh db:init
  -- produces the same table as a migrated one; without them the two drift.
  sent_via     TEXT,
  send_error   TEXT,
  bounced_at   TEXT,
  edited_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_outreach_entity ON outreach(entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_date   ON outreach(queue_date, rank);

-- The history pages read by status, newest first.
CREATE INDEX IF NOT EXISTS idx_outreach_status_sent    ON outreach(status, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_status_created ON outreach(status, created_at DESC);

-- One draft per entity per day. Belt and braces against double-drafting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_unique ON outreach(entity_id, queue_date);

-- ---------------------------------------------------------------------------
-- suppressions — CAN-SPAM opt-outs and manual blocks. Checked before every
-- queue build and every draft. Nothing removes a row from here automatically.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  key        TEXT PRIMARY KEY,         -- normalized email or "domain:x.com"
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- budget — per-day resource counters. The circuit breaker reads these before
-- every fetch and every AI call.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget (
  day        TEXT NOT NULL,
  metric     TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

-- ---------------------------------------------------------------------------
-- runs — one row per cron invocation, for the dashboard and for spotting
-- runaway usage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,           -- crawl | queue
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT,                    -- JSON
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

-- ---------------------------------------------------------------------------
-- source_cursor — keyword rotation state for automated discovery.
--
-- Lets the CT-log sweep work through the whole keyword list over time instead
-- of re-querying the same few every day, and records which keywords actually
-- yield leads so the list can be pruned.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_cursor (
  keyword     TEXT PRIMARY KEY,
  last_run_at TEXT,
  total_found INTEGER NOT NULL DEFAULT 0,
  runs        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_source_cursor_run ON source_cursor(last_run_at);

-- ---------------------------------------------------------------------------
-- keywords — the discovery vocabulary, harvested rather than hand-written.
--
-- Terms come from Wikipedia's enumerations of fashion subcultures and
-- aesthetics, and from mining the text of businesses we already scored well.
-- Each is then validated against real crt.sh yield, so the list prunes itself:
-- a term that never returns certificates stops being queried.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keywords (
  keyword      TEXT PRIMARY KEY,
  niche        TEXT,
  source       TEXT NOT NULL,          -- seed | wikipedia:<page> | corpus
  status       TEXT NOT NULL DEFAULT 'UNVALIDATED', -- UNVALIDATED | ACTIVE | DEAD
  certs_seen   INTEGER,                -- crt.sh result count at validation
  domains_kept INTEGER NOT NULL DEFAULT 0,
  leads_found  INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  runs         INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(status, last_run_at);
CREATE INDEX IF NOT EXISTS idx_keywords_niche  ON keywords(niche);


-- ---------------------------------------------------------------------------
-- feedback — every human decision, and the reason given for it.
--
-- Added by migration 002, repeated here so db:init produces a database the
-- dashboard can actually query. The reason text is the most valuable output of
-- the whole system: it is what teaches the scoring what Lucia actually wants,
-- and it is where a skip reason lives, since the outreach row does not hold one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  outreach_id   TEXT,
  decision      TEXT NOT NULL,          -- SENT | SKIPPED | BLOCKED | BOUNCED
  reason        TEXT,                   -- free text from the reviewer
  reviewer      TEXT,
  score_at_time INTEGER,
  niche_at_time TEXT,
  created_at    TEXT NOT NULL,
  applied       INTEGER NOT NULL DEFAULT 0  -- folded into lessons yet?
);

CREATE INDEX IF NOT EXISTS idx_feedback_entity   ON feedback(entity_id);
CREATE INDEX IF NOT EXISTS idx_feedback_applied  ON feedback(applied, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_outreach ON feedback(outreach_id);

-- ---------------------------------------------------------------------------
-- lessons — general rules derived from that feedback (migration 002).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lessons (
  id           TEXT PRIMARY KEY,
  lesson       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'AVOID',  -- AVOID | PREFER
  niche        TEXT,
  weight       INTEGER NOT NULL DEFAULT 1,
  source_count INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lessons_active ON lessons(active, weight DESC);

-- ---------------------------------------------------------------------------
-- app_settings — small operational state that has to survive deploys
-- (migration 003). Holds the Zoho OAuth refresh token and account id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);
