// Deleting a profile is the only irreversible thing in the system.
//
// Two failures would be quiet and unfixable. Leaving entity_keys behind makes
// every business that profile ever found permanently undiscoverable by every
// other profile — the database keeps enforcing a claim for something that no
// longer exists. And deleting the last profile leaves a system with nowhere to
// put anything, which nothing else in the code is written to survive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  archiveProfile, deleteProfile, listProfiles, profileFootprint, resolveProfile, updateProfile,
} from '../src/profiles.js';
import { resolveEntity } from '../src/entity.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function fresh() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(`
    INSERT INTO profiles (id,slug,name,active,is_default,created_at,updated_at)
      VALUES ('p-medium','medium','Medium businesses',1,0,'2026-01-02','2026-01-02');
    INSERT INTO entities (id,profile_id,display_name,domain,contact_email,state,first_seen_at,updated_at)
      VALUES ('e1','p-medium','Northgate Dental','northgate.com','a@northgate.com','CONTACTED','2026-09-01','2026-09-01');
    INSERT INTO entity_keys (key,entity_id,kind,created_at) VALUES ('domain:northgate.com','e1','domain','2026-09-01');
    INSERT INTO outreach (id,profile_id,entity_id,queue_date,rank,subject,body,status,created_at,sent_at)
      VALUES ('o1','p-medium','e1','2026-09-01',1,'s','b','SENT','2026-09-01','2026-09-01T10:00:00Z');
    INSERT INTO feedback (id,profile_id,entity_id,outreach_id,decision,reason,reviewer,created_at)
      VALUES ('f1','p-medium','e1','o1','SENT',NULL,'test','2026-09-01');
    INSERT INTO snapshots (id,entity_id,url,fetched_at,ok) VALUES ('s1','e1','https://x','2026-09-01',1);
    INSERT INTO keywords (profile_id,keyword,source,status,added_at)
      VALUES ('p-medium','dentist','test','ACTIVE','2026-09-01');
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
    async batch(st) { return st.map((x) => ({ meta: { changes: run(x.sql, x.args).changes } })); },
  };
  return { raw, db };
}

// ---------------------------------------------------------------------------

test('the confirmation is told exactly what it is about to destroy', async () => {
  const { db } = fresh();
  const f = await profileFootprint(db, 'p-medium');
  assert.deepEqual(f, { leads: 1, sent: 1, drafts: 1, decisions: 1, lessons: 0 });
});

test('the typed name has to match, and is checked here rather than only in the browser', async () => {
  const { raw, db } = fresh();
  const wrong = await deleteProfile(db, 'p-medium', { confirmName: 'Medium' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /did not match/);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entities").get().n, 1, 'nothing was touched');
});

test('deleting releases the dedup keys, so the businesses can be found again', async () => {
  const { raw, db } = fresh();
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM entity_keys').get().n, 1);

  const res = await deleteProfile(db, 'p-medium', { confirmName: 'Medium businesses' });
  assert.equal(res.ok, true);
  assert.equal(res.leads, 1);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM entity_keys').get().n, 0,
    'a key left behind makes that business undiscoverable by everyone, forever');

  // And prove it: the surviving profile can now find the same business.
  const again = await resolveEntity(db, 'p-creative', {
    display_name: 'Northgate Dental', website: 'https://northgate.com',
  });
  assert.equal(again.created, true, 'the claim died with the profile that made it');
});

test('deleting takes everything that belonged to it and nothing that did not', async () => {
  const { raw, db } = fresh();
  raw.exec(`INSERT INTO entities (id,profile_id,display_name,state,first_seen_at,updated_at)
            VALUES ('keep','p-creative','Marlowe','NURTURE','2026-09-01','2026-09-01')`);

  await deleteProfile(db, 'p-medium', { confirmName: 'Medium businesses' });

  for (const t of ['entities', 'outreach', 'feedback', 'keywords']) {
    assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${t} WHERE profile_id='p-medium'`).get().n, 0, t);
  }
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 0, 'children go too');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entities WHERE profile_id='p-creative'").get().n, 1,
    'the other profile is untouched');
});

test('the last profile cannot be deleted', async () => {
  const { raw, db } = fresh();
  raw.exec("DELETE FROM profiles WHERE id='p-creative'");
  const res = await deleteProfile(db, 'p-medium', { confirmName: 'Medium businesses' });
  assert.equal(res.ok, false);
  assert.match(res.error, /only profile/);
});

test('deleting the default hands the default to someone else', async () => {
  const { raw, db } = fresh();
  raw.exec("UPDATE profiles SET is_default = 1 WHERE id='p-medium'");
  raw.exec("UPDATE profiles SET is_default = 0 WHERE id='p-creative'");

  await deleteProfile(db, 'p-medium', { confirmName: 'Medium businesses' });
  const def = raw.prepare('SELECT id FROM profiles WHERE is_default = 1').all();
  assert.equal(def.length, 1, 'exactly one default survives');
  assert.equal(def[0].id, 'p-creative');
});

test('archiving hides a profile and keeps every row', async () => {
  const { raw, db } = fresh();
  assert.equal((await archiveProfile(db, 'p-medium')).ok, true);

  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entities WHERE profile_id='p-medium'").get().n, 1,
    'nothing is lost');
  assert.equal((await listProfiles(db)).length, 1, 'and it is out of the switcher and the cron');

  assert.equal((await archiveProfile(db, 'p-medium', { active: true })).ok, true);
  assert.equal((await listProfiles(db)).length, 2, 'restoring brings it back');
});

test('archiving the last active profile is refused', async () => {
  const { raw, db } = fresh();
  raw.exec("UPDATE profiles SET active = 0 WHERE id='p-creative'");
  const res = await archiveProfile(db, 'p-medium');
  assert.equal(res.ok, false);
  assert.match(res.error, /only active profile/);
});

test('archiving the default moves the default to one that still runs', async () => {
  const { raw, db } = fresh();
  raw.exec("UPDATE profiles SET is_default = 1 WHERE id='p-medium'");
  raw.exec("UPDATE profiles SET is_default = 0 WHERE id='p-creative'");

  await archiveProfile(db, 'p-medium');
  assert.equal((await resolveProfile(db, null)).id, 'p-creative',
    'resolving must never land on something that is not running');
});

test('budgets are stored per profile and read back', async () => {
  const { db } = fresh();
  assert.equal((await updateProfile(db, 'p-medium', { budgets: { fetch: 1200, ai: 40 } })).ok, true);
  const p = await resolveProfile(db, 'medium');
  assert.deepEqual(p.budgets, { fetch: 1200, ai: 40 });

  assert.equal((await updateProfile(db, 'p-medium', { name: 'X' })).ok, false, 'a name that short is refused');
});
