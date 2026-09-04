-- ---------------------------------------------------------------------------
-- feedback — every human decision, with the reason.
--
-- This is the training signal. When Oliver skips a lead and says why, that
-- reason is worth more than any heuristic in the codebase: it is Lucia's
-- actual taste, stated in words, about a specific real business.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  outreach_id TEXT,
  decision    TEXT NOT NULL,            -- SENT | SKIPPED | BLOCKED
  reason      TEXT,                     -- free text from the reviewer
  reviewer    TEXT,
  score_at_time INTEGER,
  niche_at_time TEXT,
  created_at  TEXT NOT NULL,
  applied     INTEGER NOT NULL DEFAULT 0  -- has this been folded into lessons?
);

CREATE INDEX IF NOT EXISTS idx_feedback_entity  ON feedback(entity_id);
CREATE INDEX IF NOT EXISTS idx_feedback_applied ON feedback(applied, created_at);

-- ---------------------------------------------------------------------------
-- lessons — what the system has learned, in plain language.
--
-- Derived from feedback and injected into the evaluation prompt, so the model
-- applies it to businesses it has not seen yet. Deliberately NOT used to
-- re-score the existing database: a lesson changes how the next evaluation
-- goes, and an old lead only gets the benefit if it comes round again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lessons (
  id          TEXT PRIMARY KEY,
  lesson      TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'AVOID',  -- AVOID | PREFER
  niche       TEXT,                            -- null = applies everywhere
  weight      INTEGER NOT NULL DEFAULT 1,      -- times this pattern recurred
  source_count INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lessons_active ON lessons(active, weight DESC);

-- Render tier used for the audit, so we can see when the browser was needed.
ALTER TABLE snapshots ADD COLUMN render_mode TEXT;   -- static | browser
