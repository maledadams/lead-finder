import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { applyCorrection } from '../src/correct.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

/** A database, plus an AI that returns whatever the test dictates. */
function harness(modelReply) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  // A profile brings its own categories now, so the fixture states them rather
  // than relying on a taxonomy that used to be baked into the code.
  raw.exec(`
    INSERT INTO profiles (id,slug,name,active,is_default,created_at,updated_at)
      VALUES ('p-creative','creative','Creative',1,1,'2026-01-01','2026-01-01');
    UPDATE profiles SET niches = '{"beauty_wellness":{"label":"Beauty"},"food_bev":{"label":"Food"}}'
      WHERE id = 'p-creative';
    INSERT INTO entities (id, profile_id, display_name, domain, website, niche, contact_email, score, score_reason, state, first_seen_at, updated_at, last_evaluated_at)
      VALUES ('e1','p-creative','Glasshaus Gardens','fettlebotanic.com','https://fettlebotanic.com',
              'beauty_wellness','hello@fettlebotanic.com',63,'model rationale','EVALUATED',
              '2026-01-01','2026-01-01','2026-01-01');
    INSERT INTO outreach (id, profile_id, entity_id, queue_date, rank, subject, body, status, created_at, sent_at)
      VALUES ('o-sent','p-creative','e1','2026-01-05',1,
              'Glasshaus Gardens — notes on your product pages',
              'Hello,\n\nGlasshaus Gardens could benefit from clearer product pages.',
              'SENT','2026-01-05','2026-01-05T10:00:00Z'),
             ('o-draft','p-creative','e1','2026-01-08',1,
              'Glasshaus Gardens — notes on your product pages',
              'Hello,\n\nGlasshaus Gardens could benefit from clearer product pages.',
              'DRAFT','2026-01-08',NULL);
    INSERT INTO snapshots (id, entity_id, url, fetched_at, ok, text_sample)
      VALUES ('s1','e1','https://fettlebotanic.com','2026-01-02',1,
              'Fettle Botanic Supply Co. Loose leaf tea, herbal blends and tisanes.');
  `);
  const run = (sql, args) => raw.prepare(sql).run(...args);
  const mk = (sql, args = []) => ({
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: run(sql, args).changes } }),
  });
  const db = { prepare: (sql) => ({ ...mk(sql), bind: (...a) => mk(sql, a) }) };
  const env = { AI: { run: async () => ({ response: modelReply }) } };
  return { raw, db, env };
}

test('a note fixes the name and the niche together', async () => {
  const h = harness({
    display_name: 'Fettle Botanic Supply Co',
    niche: 'food_bev',
    contact_email: null,
    summary: 'The site sells tea, not skincare, and is not Glasshaus Gardens.',
  });
  const res = await applyCorrection(h.env, h.db, 'e1',
    "it's actually fettle botanic not glasshaus gardens, and it sells tea");

  assert.equal(res.ok, true);
  assert.deepEqual(res.changed.sort(), ['display_name', 'niche']);

  const e = h.raw.prepare("SELECT * FROM entities WHERE id='e1'").get();
  assert.equal(e.display_name, 'Fettle Botanic Supply Co');
  assert.equal(e.niche, 'food_bev');
  assert.equal(e.last_evaluated_at, null, 'the lead must be re-scored as what it really is');
  assert.equal(e.score_reason, 'model rationale', 'the old rationale is not destroyed');
});

test('an invented niche is refused, not written', async () => {
  const h = harness({
    display_name: null, niche: 'tea_shop', contact_email: null, summary: 'tea',
  });
  const res = await applyCorrection(h.env, h.db, 'e1', 'it sells tea');
  assert.equal(res.ok, true);
  assert.deepEqual(res.changed, []);
  assert.match(res.rejected[0], /not one of the known categories/);
  assert.equal(h.raw.prepare("SELECT niche FROM entities WHERE id='e1'").get().niche, 'beauty_wellness');
});

test('an invented address is refused', async () => {
  const h = harness({
    display_name: null, niche: null, contact_email: 'cre@ivity.get', summary: 'email',
  });
  const res = await applyCorrection(h.env, h.db, 'e1', 'the email is wrong');
  assert.deepEqual(res.changed, []);
  assert.match(res.rejected[0], /not a usable address/);
});

test('the correction is recorded but never becomes a lesson', async () => {
  const h = harness({
    display_name: 'Fettle Botanic', niche: null, contact_email: null, summary: 'renamed',
  });
  await applyCorrection(h.env, h.db, 'e1', 'wrong name, it is fettle botanic');

  const f = h.raw.prepare("SELECT decision, reason FROM feedback WHERE entity_id='e1'").get();
  assert.equal(f.decision, 'CORRECTED');
  assert.match(f.reason, /fettle botanic/i);
  // deriveLessons excludes CORRECTED, so a fact about a record can never be
  // read as a reason to avoid a whole category.
  const l = readFileSync(new URL('../src/learning.js', import.meta.url), 'utf8');
  assert.match(l, /NOT IN \('BOUNCED','CORRECTED'\)/);
});

test('an empty note is refused before any model call', async () => {
  const h = harness(null);
  assert.deepEqual(await applyCorrection(h.env, h.db, 'e1', '  '), { ok: false, error: 'say what is wrong' });
});

test('a missing entity is reported', async () => {
  const h = harness({ display_name: null, niche: null, contact_email: null, summary: '' });
  assert.deepEqual(await applyCorrection(h.env, h.db, 'nope', 'anything'), { ok: false, error: 'not-found' });
});

// ---------------------------------------------------------------------------
// What a note MEANS depends on whether it changed anything.
// ---------------------------------------------------------------------------

test('a note that changes nothing becomes a ranking judgement', async () => {
  // "too corporate for me" is not a fact to fix — it is the reviewer saying
  // this lead is not worth having, which is what the ranking is built from.
  const h = harness({ display_name: null, niche: null, contact_email: null, summary: 'no change' });
  h.env.AI.run = async (_m, opts) => {
    const asked = JSON.stringify(opts).includes('Adjust the score');
    return { response: asked ? { score: 30, reason: 'reviewer finds it too corporate' }
      : { display_name: null, niche: null, contact_email: null, summary: 'no change' } };
  };

  const res = await applyCorrection(h.env, h.db, 'e1', 'too corporate for me, not the kind of work I want');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'judgement');
  assert.deepEqual(res.changed, []);

  const f = h.raw.prepare("SELECT decision, reason FROM feedback WHERE entity_id='e1'").get();
  assert.equal(f.decision, 'NOTE', 'must be readable by deriveLessons');
  assert.match(f.reason, /too corporate/);
});

test('a note that fixes a fact is a correction, and never becomes a lesson', async () => {
  const h = harness({
    display_name: 'Fettle Botanic', niche: 'food_bev', contact_email: null, summary: 'sells tea',
  });
  const res = await applyCorrection(h.env, h.db, 'e1', 'its fettle botanic and it sells tea');
  assert.equal(res.kind, 'correction');
  assert.equal(h.raw.prepare("SELECT decision FROM feedback WHERE entity_id='e1'").get().decision, 'CORRECTED');
});

test('the lesson query reads judgements but not corrections', async () => {
  const src = readFileSync(new URL('../src/learning.js', import.meta.url), 'utf8');
  const where = src.slice(src.indexOf('FROM feedback f'), src.indexOf('ORDER BY f.created_at'));
  assert.match(where, /NOT IN \('BOUNCED','CORRECTED'\)/);
  assert.doesNotMatch(where, /'NOTE'/, "a plain note must not be excluded — it is the ranking signal");
});

// ---------------------------------------------------------------------------
// A correction that stops at the record is only half a correction.
// ---------------------------------------------------------------------------

test('a renamed business is renamed in the emails already written about it', async () => {
  const h = harness({
    display_name: 'Fettle Botanic Supply Co',
    niche: 'food_bev',
    contact_email: null,
    summary: 'The site sells tea, not skincare, and is not Glasshaus Gardens.',
  });
  const res = await applyCorrection(h.env, h.db, 'e1',
    "it's actually fettle botanic not glasshaus gardens, and it sells tea");

  assert.equal(res.ok, true);
  assert.equal(res.renamed, 2, 'the sent email and the draft both carried the old name');

  const rows = h.raw.prepare('SELECT id, subject, body FROM outreach ORDER BY id').all();
  for (const r of rows) {
    assert.match(r.subject, /Fettle Botanic Supply Co/, `${r.id} subject`);
    assert.ok(!r.subject.includes('Glasshaus'), `${r.id} still names the wrong business`);
    assert.ok(!r.body.includes('Glasshaus'), `${r.id} body still names the wrong business`);
  }

  // Only the name moved. Nothing about the offer may be rewritten by a rename.
  const sent = rows.find((r) => r.id === 'o-sent');
  assert.match(sent.body, /could benefit from clearer product pages/);
});

test('an opinion leaves the sent emails exactly as they were', async () => {
  const h = harness({
    kind: 'opinion', display_name: null, niche: null, contact_email: null,
    summary: 'Not the kind of business I want.',
  });
  const before = h.raw.prepare("SELECT subject FROM outreach WHERE id='o-sent'").get().subject;
  const res = await applyCorrection(h.env, h.db, 'e1', 'too corporate for me');

  assert.equal(res.renamed, 0);
  assert.equal(h.raw.prepare("SELECT subject FROM outreach WHERE id='o-sent'").get().subject, before);
});
