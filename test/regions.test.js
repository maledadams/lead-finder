// Where the crawl looks.
//
// The dangerous failure is a block that does not block. "Never crawl Miami
// again" has to reach the built-in list too, or it silently means "never crawl
// the Miami you added by hand", and the sweeps carry on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  blockRegion, boxAround, complianceNote, metrosFor, removeRegion, setPriority, slugify,
} from '../src/regions.js';
import { METROS } from '../src/metros.js';

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
    async batch(st) { return st.map((x) => ({ meta: { changes: run(x.sql, x.args).changes } })); },
  };
  return { raw, db };
}

const addCity = (raw, { slug, name, country = 'US', priority = 0, ack = "'2026-09-09'" }) =>
  raw.exec(`INSERT INTO regions (id, profile_id, kind, country, name, slug, bbox, priority,
              active, source, acknowledged_at, created_at)
            VALUES ('${slug}', NULL, 'city', '${country}', '${name}', '${slug}',
              '[40.0,-80.0,40.1,-79.9]', ${priority}, 1, 'test', ${ack}, '2026-09-09')`);

const profile = { id: 'p-creative', metros: null };

// ---------------------------------------------------------------------------

test('an empty table means exactly the built-in list', async () => {
  const { db } = fresh();
  const out = await metrosFor(db, profile);
  assert.equal(out.length, METROS.length, 'nothing added, nothing lost');
  assert.deepEqual(out[0], METROS[0], 'and in the same order');
});

test('an added place is swept before the built-in ones', async () => {
  const { raw, db } = fresh();
  addCity(raw, { slug: 'savannah-us', name: 'Savannah', priority: 5 });

  const out = await metrosFor(db, profile);
  assert.equal(out[0][0], 'savannah-us', 'priority puts it first');
  assert.equal(out.length, METROS.length + 1);
});

test('a block reaches the built-in list, not only what you added', async () => {
  const { db } = fresh();
  const victim = METROS[0][0];

  await blockRegion(db, { slug: victim, name: victim });
  const out = await metrosFor(db, profile);

  assert.ok(!out.some(([slug]) => slug === victim),
    `${victim} is built in and must still be blockable`);
  assert.equal(out.length, METROS.length - 1);
});

test('a non-US place is configured but not crawled until it is acknowledged', async () => {
  const { raw, db } = fresh();
  addCity(raw, { slug: 'toronto-ca', name: 'Toronto', country: 'CA', ack: 'NULL' });

  let out = await metrosFor(db, profile);
  assert.ok(!out.some(([s]) => s === 'toronto-ca'),
    'CASL is not CAN-SPAM — nothing is swept there on the strength of a click');

  raw.exec("UPDATE regions SET acknowledged_at = '2026-09-09' WHERE slug = 'toronto-ca'");
  out = await metrosFor(db, profile);
  assert.ok(out.some(([s]) => s === 'toronto-ca'), 'and once acknowledged, it is');
});

test('a US place needs no acknowledgement', async () => {
  const { raw, db } = fresh();
  addCity(raw, { slug: 'savannah-us', name: 'Savannah', ack: 'NULL' });
  const out = await metrosFor(db, profile);
  assert.ok(out.some(([s]) => s === 'savannah-us'),
    'CAN-SPAM is the rule the sender already follows, so a US place is never gated');
});

test('a profile with its own geography keeps it, plus additions', async () => {
  const { raw, db } = fresh();
  addCity(raw, { slug: 'savannah-us', name: 'Savannah' });

  const narrow = { id: 'p-medium', metros: [['austin-tx', [30.2, -97.8, 30.3, -97.7]]] };
  const out = await metrosFor(db, narrow);
  assert.equal(out.length, 2, 'its own list, not the national one');
  assert.deepEqual(out.map(([s]) => s).sort(), ['austin-tx', 'savannah-us']);
});

test('priority is clamped rather than trusted', async () => {
  const { raw, db } = fresh();
  addCity(raw, { slug: 'savannah-us', name: 'Savannah' });
  assert.equal((await setPriority(db, 'savannah-us', 9999)).priority, 10);
  assert.equal((await setPriority(db, 'savannah-us', -9999)).priority, -10);
  assert.equal((await setPriority(db, 'savannah-us', 'nonsense')).priority, 0);
});

test('removing a place is not found when it is not there', async () => {
  const { db } = fresh();
  assert.deepEqual(await removeRegion(db, 'nope'), { ok: false, error: 'not-found' });
});

test('a box covers the same ground however far north it is', () => {
  const width = ([s, w, , e]) => (e - w) * Math.cos((s * Math.PI) / 180);
  const anchorage = boxAround(61.2181, -149.9003);
  const miami = boxAround(25.7617, -80.1918);
  assert.ok(Math.abs(width(anchorage) - width(miami)) < 0.01,
    'unscaled longitude would make the northern box a thin sliver');
});

test('slugs survive accents', () => {
  assert.equal(slugify('Montréal'), 'montreal');
  assert.equal(slugify('São Paulo'), 'sao-paulo');
});

test('every country outside the US carries a warning', () => {
  assert.equal(complianceNote('US'), null);
  assert.match(complianceNote('CA'), /CASL/);
  assert.match(complianceNote('DE'), /GDPR/, 'a country with no entry still warns');
});

test('geography refuses to resolve without a profile', async () => {
  const { db } = fresh();
  await assert.rejects(() => metrosFor(db, null), /needs a profile/);
});
