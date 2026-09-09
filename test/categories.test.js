// Sorting skips into categories.
//
// The failure that matters is not a wrong bucket — it is a stale one. Edit a
// definition and the skips filed under the old meaning keep their old bucket,
// the bars keep moving, and nothing anywhere says the chart now means something
// different. The version stamp exists for that, so most of this file is about it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  categoryCounts, classifyPending, deleteCategory, listCategories,
  matchByKeyword, seedDefaultCategories, upsertCategory,
} from '../src/categories.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

// A fresh install ships no profile and no categories: setting one up creates
// both, which is what this fixture stands in for.
async function fresh({ reply = null } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(`
    INSERT INTO profiles (id,slug,name,active,is_default,created_at,updated_at)
      VALUES ('p-creative','creative','Creative',1,1,'2026-01-01','2026-01-01');
    INSERT INTO entities (id, profile_id, display_name, state, first_seen_at, updated_at)
      VALUES ('e1','p-creative','Marlowe','NURTURE','2026-09-01','2026-09-01');
  `);
  const run = (sql, args) => raw.prepare(sql).run(...args);
  const mk = (sql, args = []) => ({
    sql, args,
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: run(sql, args).changes } }),
  });
  const calls = [];
  const db = {
    prepare: (sql) => ({ ...mk(sql), bind: (...a) => mk(sql, a) }),
    async batch(st) { return st.map((x) => ({ meta: { changes: run(x.sql, x.args).changes } })); },
  };
  const env = { AI: { run: async (model, opts) => { calls.push(opts); return { response: reply }; } } };
  await seedDefaultCategories(db, 'p-creative');
  return { raw, db, env, calls };
}

let clock = 0;
const addSkip = (raw, id, reason) => raw.exec(
  `INSERT INTO feedback (id, profile_id, entity_id, decision, reason, reviewer, created_at)
   VALUES ('${id}','p-creative','e1','SKIPPED','${reason}','test','2026-09-05T00:00:${
     String(59 - (clock++)).padStart(2, '0')}Z')`
);

// ---------------------------------------------------------------------------

test('the shipped categories are data, and can be edited and removed', async () => {
  const { raw, db } = await fresh();
  const before = await listCategories(db, 'p-creative');
  assert.equal(before.length, 4, 'four arrive seeded');

  await deleteCategory(db, 'p-creative', before[0].id);
  assert.equal((await listCategories(db, 'p-creative')).length, 3,
    'nothing is built in — every one of them can go');

  const made = await upsertCategory(db, 'p-creative', { name: 'Too far away' });
  assert.equal(made.ok, true);
  assert.equal(made.slug, 'too_far_away');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM skip_categories').get().n, 4);
});

test('a keyword match costs no model call at all', async () => {
  const { raw, db, env, calls } = await fresh();
  addSkip(raw, 'f1', 'their site is already great');

  const report = await classifyPending(env, db, 'p-creative');
  assert.equal(report.by_keyword, 1);
  assert.equal(report.calls, 0, 'the model was never asked');
  assert.equal(calls.length, 0);

  const row = raw.prepare("SELECT skip_category_id FROM feedback WHERE id='f1'").get();
  assert.match(row.skip_category_id, /no_value$/);
});

test('everything the keywords miss goes in ONE call, not one each', async () => {
  const { raw, db, env, calls } = await fresh({
    reply: { answers: [{ i: 0, category: 'not_a_fit' }, { i: 1, category: 'difficult' }, { i: 2, category: 'none' }] },
  });
  addSkip(raw, 'f1', 'they run twelve locations across three states');
  addSkip(raw, 'f2', 'reception would not put me through to anyone');
  addSkip(raw, 'f3', 'something entirely unrelated to any bucket');

  const report = await classifyPending(env, db, 'p-creative');
  assert.equal(calls.length, 1, 'three skips, one call');
  assert.equal(report.by_model, 2);

  const rows = raw.prepare('SELECT id, skip_category_id FROM feedback ORDER BY id').all();
  assert.match(rows[0].skip_category_id, /not_a_fit$/);
  assert.match(rows[1].skip_category_id, /difficult$/);
  assert.equal(rows[2].skip_category_id, null, '"none" is left unsorted rather than forced');
});

test('nothing is ever classified twice', async () => {
  const { raw, db, env, calls } = await fresh({ reply: { answers: [{ i: 0, category: 'not_a_fit' }] } });
  addSkip(raw, 'f1', 'they run twelve locations');

  await classifyPending(env, db, 'p-creative');
  assert.equal(calls.length, 1);

  const second = await classifyPending(env, db, 'p-creative');
  assert.equal(second.pending, 0, 'nothing left to do');
  assert.equal(calls.length, 1, 'and no second call was made');
});

test('a reason the model could not place is not reconsidered forever', async () => {
  const { raw, db, env, calls } = await fresh({ reply: { answers: [{ i: 0, category: 'none' }] } });
  addSkip(raw, 'f1', 'utterly unclassifiable');

  await classifyPending(env, db, 'p-creative');
  await classifyPending(env, db, 'p-creative');
  assert.equal(calls.length, 1, 'an unsorted row is stamped, not retried every pass');
});

test('editing a definition re-sorts what was filed under the old one', async () => {
  const { raw, db, env, calls } = await fresh({ reply: { answers: [{ i: 0, category: 'not_a_fit' }] } });
  addSkip(raw, 'f1', 'they run twelve locations');
  await classifyPending(env, db, 'p-creative');
  assert.equal(calls.length, 1);

  const cats = await listCategories(db, 'p-creative');
  await upsertCategory(db, 'p-creative', {
    id: cats.find((c) => c.slug === 'not_a_fit').id,
    name: 'Not a fit',
    definition: 'A completely different meaning from before.',
  });

  const after = await classifyPending(env, db, 'p-creative');
  assert.equal(after.pending, 1, 'the old answer is no longer trusted');
  assert.equal(calls.length, 2, 'and it is asked again under the new definition');
});

test('deleting a category keeps the reasons and returns them to unsorted', async () => {
  const { raw, db, env } = await fresh();
  addSkip(raw, 'f1', 'their site is already great');
  await classifyPending(env, db, 'p-creative');

  const cat = (await listCategories(db, 'p-creative')).find((c) => c.slug === 'no_value');
  await deleteCategory(db, 'p-creative', cat.id);

  const row = raw.prepare("SELECT reason, skip_category_id FROM feedback WHERE id='f1'").get();
  assert.equal(row.reason, 'their site is already great', 'the words a person typed survive');
  assert.equal(row.skip_category_id, null, 'and it is simply unsorted again');
});

test('the chart shows the busiest four and says what it left out', async () => {
  const { raw, db } = await fresh();
  // Six categories, so the top four plus an honest remainder.
  for (const n of ['Alpha', 'Beta']) await upsertCategory(db, 'p-creative', { name: n });
  const cats = await listCategories(db, 'p-creative');
  let i = 0;
  for (const c of cats) {
    // 6,5,4,3,2,1 skips, so the ordering is unambiguous.
    for (let k = 0; k < 6 - i; k++) {
      raw.exec(`INSERT INTO feedback (id, profile_id, entity_id, decision, reason, skip_category_id, reviewer, created_at)
                VALUES ('f${i}_${k}','p-creative','e1','SKIPPED','x','${c.id}','test','2026-09-05')`);
    }
    i++;
  }

  const rows = await categoryCounts(db, 'p-creative', '2026-09-01', '9999-12-31');
  assert.equal(rows.length, 5, 'four categories and one Other');
  assert.equal(rows[4].label, 'Other');
  assert.equal(rows[4].n, 2 + 1, 'Other is the exact remainder, not a rounding');
  assert.equal(rows.reduce((n, r) => n + r.n, 0), 6 + 5 + 4 + 3 + 2 + 1, 'and the total still adds up');
});

test('a window with an end excludes what falls outside it', async () => {
  const { raw, db } = await fresh();
  raw.exec(`INSERT INTO feedback (id, profile_id, entity_id, decision, reason, reviewer, created_at)
            VALUES ('old','p-creative','e1','SKIPPED','x','test','2026-08-30'),
                   ('mid','p-creative','e1','SKIPPED','x','test','2026-09-05'),
                   ('new','p-creative','e1','SKIPPED','x','test','2026-09-20')`);
  const rows = await categoryCounts(db, 'p-creative', '2026-09-05', '2026-09-06');
  assert.equal(rows.reduce((n, r) => n + r.n, 0), 1, 'one day means one day');
});

test('matchByKeyword needs a real keyword, not an empty one', () => {
  const cats = [{ id: 'a', keywords: 'already great,, ' }, { id: 'b', keywords: '' }];
  assert.equal(matchByKeyword('their site is already great', cats).id, 'a');
  assert.equal(matchByKeyword('nothing in common', cats), null,
    'an empty keyword must not match everything');
});

test('classification refuses to run without a profile', async () => {
  const { db, env } = await fresh();
  await assert.rejects(() => classifyPending(env, db, null), /needs a profileId/);
  await assert.rejects(() => listCategories(db, null), /needs a profileId/);
});
