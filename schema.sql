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
-- the whole system: it is what teaches the scoring what you actually want,
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
  profile_id    TEXT,             -- migration 008
  -- migration 011. SET NULL, not CASCADE: deleting a category must return its
  -- skips to unsorted, never delete the reasons a person typed.
  skip_category_id TEXT REFERENCES skip_categories(id) ON DELETE SET NULL,
  category_version INTEGER
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
  updated_at    TEXT NOT NULL,
  categories_version INTEGER NOT NULL DEFAULT 1  -- migration 011
);

CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(active, is_default);

CREATE INDEX IF NOT EXISTS idx_entities_profile ON entities(profile_id, state);
CREATE INDEX IF NOT EXISTS idx_outreach_profile ON outreach(profile_id, queue_date);
CREATE INDEX IF NOT EXISTS idx_feedback_profile ON feedback(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lessons_profile  ON lessons(profile_id, active, weight DESC);

-- NO PROFILE IS SEEDED, on purpose.
--
-- A profile carries the taxonomy, the sales copy, the scoring brief and the
-- search terms — the things that belong to whoever is running this. Shipping one
-- would mean every install inherited somebody else's, and had to edit source
-- files to get rid of them.
--
-- A database with no profile is the signal for first-run setup: the dashboard
-- shows a setup screen instead of a queue, and one sentence about who you want
-- to reach generates the rest.

-- ---------------------------------------------------------------------------
-- skip_categories — your buckets for why a lead was passed on (migration 011)
--
-- Nothing here is hardcoded. The four seeded below are data, editable and
-- deletable like any you add; the code knows only that categories exist. A skip
-- is filed by its keywords first, which is free, and by one batched model call
-- otherwise. The answer is stamped with categories_version, so editing a
-- definition re-sorts everything filed under the old one instead of leaving the
-- chart quietly wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skip_categories (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL,
  slug        TEXT NOT NULL,          -- stable id the model answers with
  name        TEXT NOT NULL,          -- how it reads on the metrics bar
  definition  TEXT,                   -- what puts a skip in here, in your words
  keywords    TEXT,                   -- comma separated; a match skips the model
  position    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skip_cat_slug ON skip_categories(profile_id, slug);
CREATE INDEX IF NOT EXISTS idx_skip_cat_active ON skip_categories(profile_id, active, position);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(profile_id, skip_category_id);

INSERT OR IGNORE INTO skip_categories
  (id, profile_id, slug, name, definition, keywords, position, active, created_at, updated_at)
SELECT p.id || ':not_a_fit', p.id, 'not_a_fit', 'Not a fit',
       'The business is the wrong kind for this profile — wrong trade, wrong size, a chain, an agency, or simply not who this operation is for.',
       'not my kind,wrong kind,not a fit,too corporate,chain,franchise,agency,not the right',
       1, 1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z' FROM profiles p
UNION ALL
SELECT p.id || ':no_value', p.id, 'no_value', 'No value',
       'There is nothing worth building for them. The site is already good, or the work they need is not work this offer covers.',
       'already great,already good,site is fine,nothing to build,no opportunity,no need,nothing obvious',
       2, 1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z' FROM profiles p
UNION ALL
SELECT p.id || ':bad_timing', p.id, 'bad_timing', 'Bad timing',
       'A fine lead, wrong moment — recently rebuilt, mid redesign, closed for the season, or otherwise worth revisiting later.',
       'just rebuilt,recently redesigned,mid redesign,new site,closed,seasonal,later,not right now,too soon',
       3, 1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z' FROM profiles p
UNION ALL
SELECT p.id || ':difficult', p.id, 'difficult', 'Difficult',
       'Reachable but not worth the friction — no way in, gatekept, a committee, an unresponsive contact, or a budget that will not stretch.',
       'no contact,cannot reach,gatekeeper,committee,no budget,too cheap,too big,hard to reach,no email',
       4, 1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z' FROM profiles p;

-- ---------------------------------------------------------------------------
-- regions — where to crawl, decided from the UI (migration 012)
--
-- src/metros.js holds 1,123 built-in US boxes and stays the fallback. This
-- table only adds to that list and subtracts from it, so an empty table means
-- exactly the built-in behaviour.
--
-- One table, two kinds: 'city' is somewhere to look, 'block' is somewhere never
-- to look again — matched by name against the built-in boxes as well, which is
-- the only way "never crawl Miami again" can mean it.
--
-- acknowledged_at is not decoration. CAN-SPAM covers the United States; the EU
-- is GDPR and Canada is CASL, which needs consent BEFORE sending and fines per
-- message. Somewhere outside the US is configured but not swept until someone
-- has said they understand that, and this column is the record that they did.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regions (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT,                     -- NULL = every profile
  kind            TEXT NOT NULL,            -- 'city' | 'block'
  country         TEXT NOT NULL DEFAULT 'US',
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,            -- the metro key the crawl uses
  bbox            TEXT,                     -- JSON [s,w,n,e]; NULL for a block
  priority        INTEGER NOT NULL DEFAULT 0,  -- higher is swept sooner
  active          INTEGER NOT NULL DEFAULT 1,
  source          TEXT,                     -- 'manual' | 'nominatim' | 'overpass'
  acknowledged_at TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_regions_use  ON regions(kind, active, priority DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_slug ON regions(kind, COALESCE(profile_id, ''), slug);

-- ---------------------------------------------------------------------------
-- docs — documentation written in the dashboard (migration 013)
--
-- One table: a folder is a document with is_folder = 1 and no body, which gives
-- one CRUD path and one delete path instead of two of each. body_md is the
-- source you edit and body_html is what it rendered to, produced once on save,
-- so viewing parses nothing. profile_scope NULL means every profile.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS docs (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT,                      -- the folder this sits in
  is_folder     INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,      -- the url
  icon          TEXT,                      -- a name from the built-in icon set
  body_md       TEXT,                      -- what you wrote
  body_html     TEXT,                      -- what it renders to, made on save
  position      INTEGER NOT NULL DEFAULT 0,
  profile_scope TEXT,                      -- NULL = every profile
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_tree ON docs(parent_id, position);

-- The first page, seeded as data. Editable and deletable like any other.
INSERT OR IGNORE INTO docs
  (id, parent_id, is_folder, title, slug, icon, body_md, body_html, position,
   profile_scope, created_at, updated_at)
VALUES
  ('doc-how-it-works', NULL, 1, 'How it works', 'how-it-works', 'folder',
   NULL, NULL, 1, NULL, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z'),
  ('doc-skips', 'doc-how-it-works', 0, 'Skips', 'skips', 'skipped',
   'Every skip teaches the system something. That is the whole reason the
dashboard refuses to let a lead go without a reason attached.

## What happens when you skip

1. The lead moves to **NURTURE** — not rejected. It can come back later.
2. Your reason is stored as feedback against that business.
3. The lead is **re-scored immediately** in light of what you said, so the
   ranking moves while you are still looking at it.
4. It cannot reappear for 45 days, so a decision never looks ignored.
5. On the next queue build the reason is folded into the general lessons the
   scoring reads before judging anything new.

## Skipping versus blocking

**Skip** means *not now*. **Never contact them** is separate and permanent — it
writes a suppression, and no profile will ever draft to that business again.
Use it for a genuine never, not for a bad fit.

## What makes a reason useful

The reason is read by a model, so it is worth a sentence rather than a word.

- Good: `their site was rebuilt this year and reads well already`
- Good: `this is a twelve-location chain with an in-house team`
- Weak: `no`
- Weak: `bad`

A weak reason still stops the lead. It just teaches nothing.

## Categories

Skips are sorted into the categories you define in **Settings → Skip
categories**, and those categories are what the metrics page counts.

Sorting is keyword-first: a category''s keywords are matched against your reason
before any model is asked, so the phrases you actually type cost nothing to
sort. Whatever the keywords miss goes into a single batched call.

If you change what a category means, everything filed under the old meaning is
sorted again — the chart never quietly starts meaning something different from
what it meant last week.

## Your own notes

This page is yours. Use the pencil to add how *you* decide, so the reasoning
survives being forgotten.
', NULL, 1, NULL, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z');
