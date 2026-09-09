-- ---------------------------------------------------------------------------
-- Documentation: pages written in the dashboard, stored as markdown.
--
-- ONE TABLE. A folder is a document with is_folder = 1 and no body. That gives
-- one CRUD path, one delete path and one scoping rule instead of two of each
-- for what is one idea: things arranged in a tree.
--
-- BOTH FORMS ARE STORED. body_md is the source you edit; body_html is what it
-- rendered to, produced once on save. Viewing a page then parses nothing, and
-- the preview endpoint calls the same renderer, so preview cannot drift from
-- the saved page.
--
-- profile_scope NULL means every profile. A JSON array of profile ids narrows
-- it. Most of what gets written down is about how the whole system works rather
-- than about one operation, so the common case is also the default.
--
-- Safe to re-run.
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./migrations/013_docs.sql
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
