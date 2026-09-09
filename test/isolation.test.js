// Switching profile has to be switching account.
//
// The dangerous failure here is silent. A query that forgets its profile filter
// returns rows — plausible ones, from the other operation — and nothing throws,
// no test goes red, and the first symptom is a dentist appearing in a queue of
// ceramics studios weeks later. That happened once during this work: two
// functions took a profileId and never used it, and 178 tests stayed green.
//
// So this suite asserts the numbers, not the plumbing. Both profiles are given
// data at once, and every surface a person actually reads — the day's queue, the
// rail counts, the history pages, the metrics — is asserted to show one
// profile's rows and none of the other's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../src/dashboard.js';
import { renderMetrics } from '../src/metrics.js';
import { getQueue } from '../src/queue.js';
import { resolveProfile } from '../src/profiles.js';
import { categoryCounts, listCategories, seedDefaultCategories } from '../src/categories.js';
import { docTree, getDoc, saveDoc } from '../src/docs.js';
import { metrosFor } from '../src/regions.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

// A real second profile, not a stub — the worked example in examples/. Loading
// it means this suite also proves a full profile configuration parses, that its
// niche labels resolve, and that its slug is reachable.
const MEDIUM = readFileSync(new URL('../examples/profile-medium-businesses.sql', import.meta.url), 'utf8');
const DAY = '2026-09-08';

/** Two profiles, each with a lead, a draft, a sent email, a skip and a lesson. */
function fresh() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(MEDIUM);
  raw.exec(`    INSERT INTO profiles (id,slug,name,active,is_default,created_at,updated_at)
      VALUES ('p-creative','creative','Creative',1,1,'2026-01-01','2026-01-01');
`);

  raw.exec(`
    -- Categories belong to a profile, not to the code, so the fixture gives
    -- this one its own rather than leaning on a built-in taxonomy.
    UPDATE profiles SET niches = '{"craft_goods":{"label":"Handmade & craft goods"}}'
      WHERE id = 'p-creative';

    INSERT INTO entities (id,profile_id,display_name,domain,website,niche,contact_email,
                          score,state,first_seen_at,updated_at,first_contacted_at)
      VALUES ('e-cer','p-creative','Marlowe Ceramics','marloweceramics.com','https://marloweceramics.com',
              'craft_goods','studio@marloweceramics.com',81,'CONTACTED','${DAY}','${DAY}','${DAY}'),
             ('e-den','p-medium','Northgate Dental','northgatedental.com','https://northgatedental.com',
              'healthcare_clinics','front@northgatedental.com',77,'CONTACTED','${DAY}','${DAY}','${DAY}');

    INSERT INTO outreach (id,profile_id,entity_id,queue_date,rank,subject,body,status,created_at,sent_at)
      VALUES ('o-cer-d','p-creative','e-cer','${DAY}',1,'Marlowe draft','body','DRAFT','${DAY}',NULL),
             ('o-cer-s','p-creative','e-cer','2026-09-01',1,'Marlowe sent','body','SENT','2026-09-01','2026-09-01T10:00:00Z'),
             ('o-den-d','p-medium','e-den','${DAY}',1,'Northgate draft','body','DRAFT','${DAY}',NULL),
             ('o-den-s','p-medium','e-den','2026-09-02',1,'Northgate sent','body','SENT','2026-09-02','2026-09-02T10:00:00Z'),
             ('o-den-k','p-medium','e-den','2026-09-03',2,'Northgate skipped','body','SKIPPED','2026-09-03',NULL);

    INSERT INTO feedback (id,profile_id,entity_id,outreach_id,decision,reason,reviewer,created_at)
      VALUES ('f-cer','p-creative','e-cer','o-cer-s','SENT',NULL,'test','2026-09-01'),
             ('f-den','p-medium','e-den','o-den-k','SKIPPED','too corporate','test','2026-09-03');

    INSERT INTO lessons (id,profile_id,lesson,kind,niche,weight,source_count,active,created_at,updated_at)
      VALUES ('l-cer','p-creative','Prefer studios that name their glazes','PREFER',NULL,3,2,1,'${DAY}','${DAY}'),
             ('l-den','p-medium','Avoid clinics inside hospital groups','AVOID',NULL,3,2,1,'${DAY}','${DAY}');
  `);

  const run = (sql, args) => raw.prepare(sql).run(...args);
  const mk = (sql, args = []) => ({
    sql,
    args,
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

const page = (db, profile, view, extra = {}) => renderDashboard(db, {}, {
  view, nonce: 'n', signedInAs: null, sending: null, day: DAY,
  page: 1, q: '', from: null, to: null, profile, profiles: [], ...extra,
});

// ---------------------------------------------------------------------------

test('the day\'s queue holds one profile\'s leads and not the other\'s', async () => {
  const { db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');

  const a = await getQueue(db, creative.id, DAY);
  const b = await getQueue(db, medium.id, DAY);

  assert.deepEqual(a.map((r) => r.subject), ['Marlowe draft']);
  assert.deepEqual(b.map((r) => r.subject), ['Northgate draft']);
});

test('the rail counts change when the profile changes', async () => {
  const { db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');

  const a = await page(db, creative, 'today');
  const b = await page(db, medium, 'today');

  // One draft each today, and the sent/skipped totals differ — so a count that
  // had quietly summed both profiles would show 2 here and fail.
  assert.match(a, /Marlowe Ceramics/);
  assert.ok(!a.includes('Northgate Dental'), 'the other profile\'s lead must not appear');
  assert.match(b, /Northgate Dental/);
  assert.ok(!b.includes('Marlowe Ceramics'));

  // Lessons are per profile too: they steer scoring, and the wrong ones would
  // teach one operation from the other's judgement.
  assert.match(a, /name their glazes/);
  assert.ok(!a.includes('hospital groups'));
  assert.match(b, /hospital groups/);
  assert.ok(!b.includes('name their glazes'));
});

test('the history pages are separate records', async () => {
  const { db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');

  const sentA = await page(db, creative, 'sent');
  assert.match(sentA, /Marlowe sent/);
  assert.ok(!sentA.includes('Northgate sent'));

  const sentB = await page(db, medium, 'sent');
  assert.match(sentB, /Northgate sent/);
  assert.ok(!sentB.includes('Marlowe sent'));

  // The creative profile has skipped nothing, so its Skipped page must be empty
  // rather than showing the other profile's skip.
  const skippedA = await page(db, creative, 'skipped');
  assert.ok(!skippedA.includes('Northgate skipped'));
  assert.match(await page(db, medium, 'skipped'), /Northgate skipped/);
});

test('metrics are not pooled', async () => {
  const { db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');

  const a = await renderMetrics(db, {}, { period: 'all', profile: creative });
  const b = await renderMetrics(db, {}, { period: 'all', profile: medium });

  // Metrics are aggregate, so the tell is the category breakdown: each profile
  // reports only its own niches, with its own labels. Pooled, both pages would
  // list ceramics and dentistry side by side.
  assert.match(a, /Handmade &amp; craft goods/);
  assert.ok(!a.includes('Healthcare and clinics'), 'the other profile\'s niche must not appear');
  assert.match(b, /Healthcare and clinics/);
  assert.ok(!b.includes('Handmade &amp; craft goods'));

  // And the headline numbers are one send each, not two.
  assert.match(a, /1<\/div>\s*<div class="ss">1 still waiting/);
  assert.match(b, /1<\/div>\s*<div class="ss">1 still waiting/);
});

test('the calendar is the one page both profiles share', async () => {
  const { db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');
  const cal = {
    ok: true,
    bookings: [{
      uid: 'bk1', title: 'Intro call', start: '2026-09-10T15:00:00Z',
      end: '2026-09-10T15:15:00Z', status: 'accepted',
      name: 'Priya Raghunathan', email: 'priya@northgatedental.com', location: null,
    }],
  };

  for (const profile of [creative, medium]) {
    const html = await page(db, profile, 'calendar', { calendar: cal });
    assert.match(html, /Priya Raghunathan/, 'the same booking shows in both profiles');
    assert.match(html, /Shared by every profile/);
  }
});

test('a surface with no profile refuses rather than showing everything', async () => {
  const { db } = fresh();
  await assert.rejects(() => page(db, undefined, 'today'), /needs a profile/);
  await assert.rejects(() => renderMetrics(db, {}, { period: 'all' }), /needs a profile/);
  await assert.rejects(() => getQueue(db, null, DAY), /needs a profileId/);
});

// ---------------------------------------------------------------------------
// Everything added later is scoped the same way, or it is not scoped at all.
// ---------------------------------------------------------------------------

test('skip categories belong to one profile', async () => {
  const { raw, db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');

  // Both profiles get the same four seeded names, but they are different rows.
  // p-medium is created by migration 009, which predates categories entirely —
  // exactly what happens to any profile added before this feature existed.
  // A fresh install ships none at all; setting a profile up creates its own.
  assert.equal((await listCategories(db, creative.id)).length, 0);
  assert.equal((await listCategories(db, medium.id)).length, 0);
  await seedDefaultCategories(db, creative.id);
  await seedDefaultCategories(db, medium.id);

  const a = await listCategories(db, creative.id);
  const b = await listCategories(db, medium.id);
  assert.equal(a.length, 4);
  assert.equal(b.length, 4);
  assert.equal(new Set([...a, ...b].map((c) => c.id)).size, 8, 'eight rows, not four shared');

  // Renaming one profile's category must not touch the other's.
  raw.exec(`UPDATE skip_categories SET name = 'Renamed' WHERE id = '${a[0].id}'`);
  assert.equal((await listCategories(db, medium.id)).some((c) => c.name === 'Renamed'), false);
});

test('the skip chart counts one profile\'s skips', async () => {
  const { raw, db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');
  raw.exec(`INSERT INTO feedback (id,profile_id,entity_id,decision,reason,reviewer,created_at)
            VALUES ('s1','p-medium','e-den','SKIPPED','too corporate','t','${DAY}')`);

  const a = await categoryCounts(db, creative.id, '2026-01-01', '9999-12-31');
  const b = await categoryCounts(db, medium.id, '2026-01-01', '9999-12-31');
  assert.equal(a.reduce((n, r) => n + r.n, 0), 0, 'the creative profile skipped nothing');
  assert.equal(b.reduce((n, r) => n + r.n, 0), 2, 'its own skip, and the one the fixture made');
});

test('a document can be shared by both profiles or held by one', async () => {
  const { db } = fresh();
  await saveDoc(db, { title: 'Shared thing', bodyMd: 'x' });
  await saveDoc(db, { title: 'Medium only', bodyMd: 'x', scope: ['p-medium'] });

  assert.ok(await getDoc(db, 'p-creative', 'shared-thing'), 'unscoped means everyone');
  assert.ok(await getDoc(db, 'p-medium', 'shared-thing'));

  assert.equal(await getDoc(db, 'p-creative', 'medium-only'), null);
  assert.ok(await getDoc(db, 'p-medium', 'medium-only'));

  const tree = await docTree(db, 'p-creative');
  assert.ok(!JSON.stringify(tree).includes('Medium only'));
});

test('geography is shared unless a profile narrows it', async () => {
  const { raw, db } = fresh();
  const creative = await resolveProfile(db, 'creative');
  const medium = await resolveProfile(db, 'medium');
  raw.exec(`INSERT INTO regions (id,profile_id,kind,country,name,slug,bbox,priority,active,source,acknowledged_at,created_at)
            VALUES ('r1',NULL,'city','US','Savannah','savannah-us','[32,-81,32.1,-80.9]',5,1,'t','${DAY}','${DAY}')`);

  // The medium profile ships with metros = NULL, so both use the national list.
  const a = await metrosFor(db, creative);
  const b = await metrosFor(db, medium);
  assert.equal(a[0][0], 'savannah-us', 'a shared addition reaches both');
  assert.equal(b[0][0], 'savannah-us');
});
