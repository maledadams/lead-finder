// Fixture data for the browser suite.
//
// Writes straight into miniflare's local D1 file, because there is no API for
// creating leads — they arrive from a crawl, which a test should not run.
//
//   pnpm run test:seed
//
// Idempotent, and dated relative to today so the queue always has something in
// it. A fixed date rots: the suite failed the morning after it was written
// because "today" had moved on.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url).pathname;

function findDatabase() {
  let files;
  try { files = readdirSync(DIR).filter((f) => f.endsWith('.sqlite')); }
  catch { throw new Error('no local D1 yet — run `pnpm run db:init:local` first'); }

  for (const f of files) {
    const db = new DatabaseSync(join(DIR, f));
    const has = db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='profiles'"
    ).get().n;
    if (has) return db;
    db.close();
  }
  throw new Error('the local D1 has no profiles table — run `pnpm run db:init:local`');
}

const db = findDatabase();
const day = (offset = 0) =>
  new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const PLACES = ['Portland, OR', 'Brooklyn, NY', 'Austin, TX', 'Asheville, NC', 'Seattle, WA'];

db.exec(`
  INSERT OR IGNORE INTO profiles (id,slug,name,active,is_default,brief,niches,personas,created_at,updated_at)
  VALUES ('p-one','ceramics','Ceramics studios',1,1,'Independent ceramics studios.',
    '{"ceramics":{"label":"Ceramics"},"food":{"label":"Food"}}',
    '{"ceramics":{"label":"Ceramics","context":"I build sites for studios.","subject":"{name} — notes","offer":"a breakdown"}}',
    '2026-01-01','2026-01-01'),
   ('p-two','clinics','Clinics',1,0,'Dental practices.',
    '{"dental":{"label":"Dental"}}',
    '{"dental":{"label":"Dental","context":"I build booking systems.","subject":"{name} — booking","offer":"a breakdown"}}',
    '2026-01-02','2026-01-02');

  INSERT OR IGNORE INTO skip_categories (id,profile_id,slug,name,definition,keywords,position,active,created_at,updated_at)
  VALUES ('c1','p-one','not_a_fit','Not a fit','Wrong kind of business.','too corporate,chain',1,1,'2026-01-01','2026-01-01'),
         ('c2','p-one','no_value','No value','Nothing worth building.','already great',2,1,'2026-01-01','2026-01-01');
`);

const entity = db.prepare(`INSERT OR IGNORE INTO entities
  (id,profile_id,display_name,domain,website,instagram,niche,contact_email,score,state,
   location_text,first_seen_at,updated_at)
  VALUES (?,'p-one',?,?,?,?,'ceramics',?,?,'CONTACTED',?,?,?)`);
const outreach = db.prepare(`INSERT OR IGNORE INTO outreach
  (id,profile_id,entity_id,queue_date,rank,subject,body,status,created_at,sent_at)
  VALUES (?,'p-one',?,?,?,?,?,?,?,?)`);

const BODY = 'Hello,\n\nA draft body for the browser suite.\n\nBest,\nRowan';
for (let i = 1; i <= 60; i++) {
  entity.run(`e${i}`, `Studio ${i}`, `studio${i}.com`, `https://studio${i}.com`,
    `studio${i}`, `hi@studio${i}.com`, 60 + (i % 35), PLACES[i % 5], day(-40), day(-40));
  // Enough SENT rows to fill more than one page of twenty.
  const status = i <= 40 ? 'SENT' : ['SKIPPED', 'BOUNCED', 'SENT', 'SKIPPED'][i % 4];
  const when = day(-(i % 20) - 1);
  outreach.run(`o${i}`, `e${i}`, when, i, `Studio ${i} — notes`, BODY, status,
    when, status === 'SENT' ? `${when}T10:00:00Z` : null);
}

// A draft dated TODAY, so the queue is never empty whatever day it is run.
outreach.run('o-today', 'e60', day(), 1, 'Studio 60 — notes', BODY, 'DRAFT', day(), null);

db.exec(`
  INSERT OR IGNORE INTO feedback (id,profile_id,entity_id,decision,reason,reviewer,created_at)
  VALUES ('f1','p-one','e2','SKIPPED','their site is already great','test','${day(-5)}'),
         ('f2','p-one','e6','SKIPPED','too corporate, this is a chain','test','${day(-4)}');
`);

const count = (sql) => db.prepare(sql).get().n;
console.log(`seeded  profiles:${count('SELECT COUNT(*) n FROM profiles')}`
  + `  entities:${count('SELECT COUNT(*) n FROM entities')}`
  + `  sent:${count("SELECT COUNT(*) n FROM outreach WHERE status='SENT'")}`
  + `  drafts today:${count(`SELECT COUNT(*) n FROM outreach WHERE queue_date='${day()}' AND status='DRAFT'`)}`);
db.close();
