// These run against real SQLite rather than a stub.
//
// Both bugs covered here live in SQL semantics — a partial unique index and an
// UPDATE OR IGNORE — which a hand-written stub cannot evaluate. node:sqlite is
// built in, so this still needs no network and no dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { markSkipped } from '../src/queue.js';
import { mergeEntities } from '../src/entity.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function fresh() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const run = (sql, args) => raw.prepare(sql).run(...args);
  const mk = (sql, args = []) => ({
    sql, args,
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: run(sql, args).changes } }),
  });
  const db = {
    prepare: (sql) => ({ ...mk(sql), bind: (...a) => mk(sql, a) }),
    async batch(st) { return st.map((s) => ({ meta: { changes: run(s.sql, s.args).changes } })); },
  };
  return { raw, db };
}

const addEntity = (raw, id) => raw.exec(
  `INSERT INTO entities (id, display_name, domain, state, score, score_reason, first_seen_at, updated_at)
   VALUES ('${id}','${id}','${id}.com','OUTREACH_READY',80,'model said: strong signals','2026-01-01','2026-01-01')`);

const addOutreach = (raw, id, entityId, date, status) => raw.exec(
  `INSERT INTO outreach (id, entity_id, queue_date, rank, subject, body, status, created_at)
   VALUES ('${id}','${entityId}','${date}',1,'s','b','${status}','2026-01-01')`);

// ---------------------------------------------------------------------------
// The index says what it means: one DRAFT per business per day.
// ---------------------------------------------------------------------------

test('two drafts for one business on one day are still refused', () => {
  const { raw } = fresh();
  addEntity(raw, 'e1');
  addOutreach(raw, 'o1', 'e1', '2026-03-01', 'DRAFT');
  assert.throws(() => addOutreach(raw, 'o2', 'e1', '2026-03-01', 'DRAFT'), /UNIQUE/);
});

test('two records of things that happened may share a date', () => {
  const { raw } = fresh();
  addEntity(raw, 'e1');
  // This is what the old, broader index forbade, and why a merge had to delete.
  addOutreach(raw, 'o1', 'e1', '2026-04-01', 'SENT');
  addOutreach(raw, 'o2', 'e1', '2026-04-01', 'BOUNCED');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM outreach WHERE queue_date='2026-04-01'").get().n, 2);
});

test("buildQueue's upsert still matches the partial index", () => {
  const { raw } = fresh();
  addEntity(raw, 'e1');
  // A conflict target must repeat a partial index's predicate to match it. If
  // this drifts from queue.js the daily build throws instead of skipping.
  const upsert = `INSERT INTO outreach (id, entity_id, queue_date, rank, persona, subject, body, cta, status, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'DRAFT', ?)
     ON CONFLICT(entity_id, queue_date) WHERE status = 'DRAFT' DO NOTHING`;
  raw.prepare(upsert).run('a', 'e1', '2026-05-01', 1, 'p', 's', 'b', 'c', 'x');
  raw.prepare(upsert).run('b', 'e1', '2026-05-01', 2, 'p', 's', 'b', 'c', 'x');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM outreach').get().n, 1);
});

// ---------------------------------------------------------------------------
// Skipping a lead must not destroy why it scored as it did.
// ---------------------------------------------------------------------------

test('skipping records the note without overwriting the scoring rationale', async () => {
  const { raw, db } = fresh();
  addEntity(raw, 'e1');
  addOutreach(raw, 'o1', 'e1', '2026-06-01', 'DRAFT');

  await markSkipped(db, 'o1', 'their site is already excellent');
  const e = raw.prepare("SELECT * FROM entities WHERE id='e1'").get();

  assert.equal(e.score_reason, 'model said: strong signals', 'the model rationale must survive a skip');
  assert.equal(e.skip_reason, 'their site is already excellent');
  assert.equal(e.state, 'NURTURE');
});

// ---------------------------------------------------------------------------
// Merging must never lose the record that an email actually went out.
// ---------------------------------------------------------------------------

test('merging entities moves sent history instead of deleting it', async () => {
  const { raw, db } = fresh();
  addEntity(raw, 'win');
  addEntity(raw, 'lose');
  // The exact collision that used to destroy data: same date on both sides,
  // and the row being merged away is the one that was actually sent.
  addOutreach(raw, 'w1', 'win', '2026-07-01', 'DRAFT');
  addOutreach(raw, 'l1', 'lose', '2026-07-01', 'SENT');
  addOutreach(raw, 'l2', 'lose', '2026-07-02', 'BOUNCED');

  await mergeEntities(db, 'win', 'lose');

  const sent = raw.prepare("SELECT * FROM outreach WHERE id='l1'").get();
  assert.ok(sent, 'the SENT row must survive');
  assert.equal(sent.entity_id, 'win', 'and belong to the surviving entity');
  assert.ok(raw.prepare("SELECT * FROM outreach WHERE id='l2'").get(), 'the BOUNCED row must survive');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entities WHERE id='lose'").get().n, 0);
});

test('merging drops only a duplicate draft, and leaves no orphans', async () => {
  const { raw, db } = fresh();
  addEntity(raw, 'win');
  addEntity(raw, 'lose');
  addOutreach(raw, 'w1', 'win', '2026-08-01', 'DRAFT');
  addOutreach(raw, 'l1', 'lose', '2026-08-01', 'DRAFT');

  await mergeEntities(db, 'win', 'lose');

  const rows = raw.prepare('SELECT id FROM outreach').all();
  assert.deepEqual(rows.map((r) => r.id), ['w1'], "the winner's draft is kept");
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM outreach WHERE entity_id='lose'").get().n, 0,
    'no row may still point at the deleted entity');
});
