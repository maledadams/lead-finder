-- ---------------------------------------------------------------------------
-- Skip categories: your buckets, not the system's.
--
-- The metrics page used to show raw skip reasons, most frequent first, which is
-- only useful while you write the same sentence twice. Categories turn "their
-- site is already great" and "nothing here needs building" into one bar you can
-- actually read a trend from.
--
-- NOTHING IS HARDCODED. The four categories below are seeded as DATA, editable
-- and deletable from Settings like any you add. The code knows only that
-- categories exist, never which ones.
--
-- HOW A SKIP FINDS ITS CATEGORY. Its keywords first, which costs nothing; then
-- one batched model call for whatever is left. The result is stamped with
-- categories_version, so a reason is classified once and never again — unless
-- you edit a definition, which bumps the version and re-sorts everything below
-- it. That version stamp is the whole reason this cannot go quietly stale.
--
-- ON DELETE SET NULL is deliberate: deleting a category returns its skips to
-- unsorted so they are classified again, rather than deleting your feedback.
--
-- Safe to re-run except the ALTER TABLE lines.
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./migrations/011_skip_categories.sql
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

ALTER TABLE feedback ADD COLUMN skip_category_id TEXT
  REFERENCES skip_categories(id) ON DELETE SET NULL;
ALTER TABLE feedback ADD COLUMN category_version INTEGER;
ALTER TABLE profiles ADD COLUMN categories_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(profile_id, skip_category_id);

-- The four you named, seeded for every profile that exists. Data, not code.
INSERT OR IGNORE INTO skip_categories
  (id, profile_id, slug, name, definition, keywords, position, active, created_at, updated_at)
SELECT p.id || ':not_a_fit', p.id, 'not_a_fit', 'Not a fit',
       'The business is the wrong kind for this profile — wrong trade, wrong size, a chain, an agency, or simply not who this operation is for.',
       'not my kind,wrong kind,not a fit,too corporate,chain,franchise,agency,not the right',
       1, 1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z' FROM profiles p
UNION ALL
SELECT p.id || ':no_value', p.id, 'no_value',  'No value',
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
