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
  has_website        INTEGER,          -- 1 | 0 | NULL (unknown)
  -- Added by migration 005. Separate from score_reason on purpose: that column
  -- holds the model's rationale and a skip note must not overwrite it.
  skip_reason        TEXT,
  profile_id   TEXT              -- migration 008
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
-- Deliberately unique across the WHOLE database, not per profile: a business
-- belongs to whichever profile discovered it first and the others skip it, so
-- nobody receives two different pitches from the same sender.
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
  render_mode    TEXT,                  -- static | browser (migration 002)
  profile_id   TEXT              -- migration 008
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
  neurons_est   REAL,
  profile_id  TEXT              -- migration 008
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
  profile_id   TEXT NOT NULL,
  url          TEXT NOT NULL,
  domain       TEXT NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 0,
  parent_entity TEXT,
  reason       TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | DONE | SKIPPED | ERROR
  added_at     TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (profile_id, url)
);

CREATE INDEX IF NOT EXISTS idx_frontier_status ON crawl_frontier(profile_id, status, priority DESC, added_at);
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
  edited_at    TEXT,
  profile_id   TEXT              -- migration 008
);

CREATE INDEX IF NOT EXISTS idx_outreach_entity ON outreach(entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_date   ON outreach(queue_date, rank);

-- The history pages read by status, newest first.
CREATE INDEX IF NOT EXISTS idx_outreach_status_sent    ON outreach(status, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_status_created ON outreach(status, created_at DESC);

-- One DRAFT per entity per day. Belt and braces against double-drafting.
--
-- Partial on purpose. Sent, skipped and bounced rows are records of things that
-- happened; two of them may share a date without conflict, which is what lets
-- an entity merge move history instead of deleting it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_unique
  ON outreach(entity_id, queue_date) WHERE status = 'DRAFT';

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
  profile_id TEXT NOT NULL,            -- per profile, so one cannot starve another
  day        TEXT NOT NULL,
  metric     TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, day, metric)
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
  error       TEXT,
  profile_id  TEXT              -- migration 008
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
  profile_id  TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  last_run_at TEXT,
  total_found INTEGER NOT NULL DEFAULT 0,
  runs        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, keyword)
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
  profile_id   TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  niche        TEXT,
  source       TEXT NOT NULL,          -- seed | wikipedia:<page> | corpus
  status       TEXT NOT NULL DEFAULT 'UNVALIDATED', -- UNVALIDATED | ACTIVE | DEAD
  certs_seen   INTEGER,                -- crt.sh result count at validation
  domains_kept INTEGER NOT NULL DEFAULT 0,
  leads_found  INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  runs         INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (profile_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(profile_id, status, last_run_at);
CREATE INDEX IF NOT EXISTS idx_keywords_niche  ON keywords(profile_id, niche);


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
  applied       INTEGER NOT NULL DEFAULT 0,  -- folded into lessons yet?
  profile_id  TEXT              -- migration 008
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
  updated_at   TEXT NOT NULL,
  profile_id  TEXT              -- migration 008
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

-- ---------------------------------------------------------------------------
-- mx_cache — does this domain accept mail at all? (migration 006)
--
-- A DNS answer, not an SMTP probe: the recipient's server is never contacted
-- and the business never learns anything happened. Checked before a lead
-- reaches the review queue and again immediately before every send.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mx_cache (
  domain      TEXT PRIMARY KEY,
  deliverable INTEGER NOT NULL,      -- 1 | 0
  detail      TEXT,                  -- mx:2 | nxdomain | implicit-mx:a | ...
  checked_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mx_checked ON mx_cache(checked_at);

-- ---------------------------------------------------------------------------
-- bounce_seen — which bounce notices have been handled (migration 007).
--
-- The bounce label is polled rather than pushed, because Zoho Mail has no
-- outgoing webhook for new mail. A notice is recorded here whether or not it
-- could be attributed to a lead, so an unattributable one is examined once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bounce_seen (
  message_id  TEXT PRIMARY KEY,     -- Zoho's message id
  outreach_id TEXT,                 -- null when it could not be attributed
  outcome     TEXT,                 -- bounced | unmatched | failed: ...
  seen_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bounce_seen_at ON bounce_seen(seen_at);

-- ---------------------------------------------------------------------------
-- profiles — separate outreach operations sharing one deployment (migration 008)
--
-- Switching profile should feel like switching account: leads, drafts, replies,
-- lessons, keywords, frontier, spend and every metric belong to exactly one
-- profile and are never mixed. The plumbing is shared — one mailbox, one
-- Cloudflare account, one database, one booking calendar — and so are
-- suppressions, because an opt-out is a person's wish rather than a profile's
-- preference, and mx_cache, because a domain either accepts mail or does not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,        -- url-safe, used in links
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,  -- which one loads first
  brief         TEXT,   -- what a person wrote; everything below derives from it
  ai_system     TEXT,   -- the scoring brief the model is judged against
  niches        TEXT,   -- {slug: {label, keywords[], signals[]}}
  personas      TEXT,   -- {niche: {label, subject, context}}
  seed_keywords TEXT,   -- [] bootstrap terms for discovery
  metros        TEXT,   -- [] where to look, for local businesses
  budgets       TEXT,   -- {fetch, ai, source, browser} per day
  discovery     TEXT,   -- {osm:{shop,craft,amenity,healthcare,office},exclude,metros}
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(active, is_default);

CREATE INDEX IF NOT EXISTS idx_entities_profile ON entities(profile_id, state);
CREATE INDEX IF NOT EXISTS idx_outreach_profile ON outreach(profile_id, queue_date);
CREATE INDEX IF NOT EXISTS idx_feedback_profile ON feedback(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lessons_profile  ON lessons(profile_id, active, weight DESC);

-- The first profile, so a fresh install has somewhere to put its leads.
--
-- Every query in the system is scoped by profile and refuses to run without
-- one, so a database with no profile row is a database where nothing works. Its
-- configuration is deliberately NULL: unset falls back to the built-in creative
-- defaults in config.js, which is what lets the original operation carry on
-- with no stored config at all.
INSERT OR IGNORE INTO profiles (id, slug, name, active, is_default, brief, created_at, updated_at)
VALUES ('p-creative', 'creative', 'Creative businesses', 1, 1,
        'Founder-led creative businesses in the United States: makers, studios, independent labels and small brands with an identity of their own.',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
