import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolveEntity } from '../src/entity.js';
import { resolveProfile, listProfiles, withConfig, budgetsFor } from '../src/profiles.js';
import { Budget } from '../src/budget.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function fresh() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(`
    INSERT INTO profiles (id,slug,name,active,is_default,created_at,updated_at)
      VALUES ('p-medium','medium','Medium business',1,0,'2026-01-02','2026-01-02');
  `);
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

// ---------------------------------------------------------------------------
// A business belongs to whichever profile found it first.
// ---------------------------------------------------------------------------

test('a business discovered by one profile is not added to another', async () => {
  const { raw, db } = fresh();
  const candidate = {
    display_name: 'Bright Smile Dental', website: 'https://brightsmile.com',
    discovery_source: 'osm:portland-or',
  };

  const first = await resolveEntity(db, 'p-creative', candidate);
  assert.equal(first.created, true);
  assert.equal(raw.prepare("SELECT profile_id FROM entities WHERE id=?").get(first.id).profile_id, 'p-creative');

  // The second profile finds the same business. It must NOT get its own copy.
  const second = await resolveEntity(db, 'p-medium', candidate);
  assert.equal(second.created, false, 'no second row may be created');
  assert.equal(second.reason, 'owned-by-another-profile');
  assert.equal(second.id, first.id);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM entities').get().n, 1,
    'exactly one row for one real business');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entities WHERE profile_id='p-medium'").get().n, 0);
});

test('the owning profile can keep enriching its own business', async () => {
  const { raw, db } = fresh();
  const first = await resolveEntity(db, 'p-creative', {
    display_name: 'Fenwick', website: 'https://fenwick.com',
  });
  const again = await resolveEntity(db, 'p-creative', {
    display_name: 'Fenwick', website: 'https://fenwick.com', contact_email: 'hi@fenwick.com',
  });
  assert.equal(again.id, first.id);
  assert.notEqual(again.reason, 'owned-by-another-profile');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM entities').get().n, 1);
});

test('different businesses in different profiles both exist', async () => {
  const { raw, db } = fresh();
  await resolveEntity(db, 'p-creative', { display_name: 'Pots', website: 'https://pots.com' });
  await resolveEntity(db, 'p-medium', { display_name: 'Dentist', website: 'https://dentist.com' });

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM entities').get().n, 2);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entities WHERE profile_id='p-creative'").get().n, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entities WHERE profile_id='p-medium'").get().n, 1);
});

// ---------------------------------------------------------------------------
// Resolving which profile a request is for
// ---------------------------------------------------------------------------

test('a slug selects its profile, and anything else falls back to the default', async () => {
  const { db } = fresh();
  assert.equal((await resolveProfile(db, 'medium')).id, 'p-medium');
  assert.equal((await resolveProfile(db, 'creative')).id, 'p-creative');
  assert.equal((await resolveProfile(db, 'nonsense')).id, 'p-creative', 'unknown slug falls back');
  assert.equal((await resolveProfile(db, null)).id, 'p-creative', 'no slug falls back');
});

test('a profile with no stored config inherits the built-in defaults', async () => {
  const { db } = fresh();
  const p = await resolveProfile(db, 'medium');
  // Nothing is configured on it yet, so it must still be usable rather than
  // arriving with empty niches and no personas.
  assert.ok(Object.keys(p.niches).length > 0, 'niches fall back');
  assert.ok(Object.keys(p.personas).length > 0, 'personas fall back');
  assert.ok(Array.isArray(p.metros) && p.metros.length > 0, 'metros fall back');
});

test('stored config wins over the defaults', () => {
  const p = withConfig({
    id: 'p-x', slug: 'x', name: 'X',
    niches: JSON.stringify({ dental: { label: 'Dental', keywords: ['dentist'] } }),
    personas: JSON.stringify({ dental: { label: 'Dental', context: 'I build for clinics.' } }),
  });
  assert.deepEqual(Object.keys(p.niches), ['dental']);
  assert.deepEqual(Object.keys(p.personas), ['dental']);
});

test('malformed stored config falls back rather than breaking the crawl', () => {
  const p = withConfig({ id: 'p-x', slug: 'x', name: 'X', niches: 'not json', personas: '{}' });
  assert.ok(Object.keys(p.niches).length > 0);
  assert.ok(Object.keys(p.personas).length > 0);
});

// ---------------------------------------------------------------------------
// Spend is per profile
// ---------------------------------------------------------------------------

test('one profile cannot spend another profile\'s budget', async () => {
  const { raw, db } = fresh();
  const limits = { fetch: 10 };

  const a = await Budget.load(db, limits, 'p-creative');
  for (let i = 0; i < 10; i++) a.spend('fetch');
  await a.flush();
  assert.equal(a.canSpend('fetch'), false, 'the first profile is exhausted');

  const b = await Budget.load(db, limits, 'p-medium');
  assert.equal(b.canSpend('fetch'), true, 'the second profile is untouched');
  assert.equal(b.remaining('fetch'), 10);

  // Mapped rather than compared directly: node:sqlite hands back null-prototype
  // rows, which assert/strict treats as unequal to a plain object literal.
  const rows = raw.prepare('SELECT profile_id, used FROM budget ORDER BY profile_id').all()
    .map((r) => `${r.profile_id}:${r.used}`);
  assert.deepEqual(rows, ['p-creative:10'], 'only the spending profile has a row');
});

test('a budget without a profile is refused rather than pooled', async () => {
  const { db } = fresh();
  await assert.rejects(() => Budget.load(db, { fetch: 1 }, null), /needs a profileId/);
});

test('per-profile budget overrides fall back to the deployment default', () => {
  assert.equal(budgetsFor({ budgets: { fetch: 100 } }, { DAILY_FETCH_BUDGET: '900' }).fetch, 100);
  assert.equal(budgetsFor({ budgets: {} }, { DAILY_FETCH_BUDGET: '900' }).fetch, 900);
  assert.equal(budgetsFor({}, {}).fetch, 900, 'and to a sane built-in');
});

test('a crawl without a profile is refused rather than pooling leads', async () => {
  const { db } = fresh();
  const { runCrawl } = await import('../src/pipeline.js');
  await assert.rejects(() => runCrawl({}, db, null), /needs a profile/);
  await assert.rejects(() => runCrawl({}, db, {}), /needs a profile/);
});

test('every profile is listed, default first', async () => {
  const { db } = fresh();
  const all = await listProfiles(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].slug, 'creative', 'the default leads');
});
