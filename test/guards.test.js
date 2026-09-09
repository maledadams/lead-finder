// Guards against the shapes of bug this codebase has actually produced.
//
// Every check here exists because something real got through a careful reading
// and was only caught by accident or by a test written for another reason. None
// of them assert a feature; they assert that a whole class of mistake fails
// loudly the next time somebody makes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SRC = readdirSync(new URL('../src', import.meta.url))
  .filter((f) => f.endsWith('.js'))
  .map((f) => [f, read(`src/${f}`)]);
const SCHEMA = read('schema.sql');

/** Every SQL string literal in a source file, with interpolations blanked out. */
function sqlLiterals(src) {
  const out = [];
  const re = /`((?:\s*(?:SELECT|INSERT|UPDATE|DELETE))[\s\S]{0,1200}?)`|'((?:SELECT|INSERT|UPDATE|DELETE)[^']{0,900})'/g;
  for (const m of src.matchAll(re)) {
    out.push({
      raw: m[1] || m[2],
      sql: (m[1] || m[2]).replace(/\$\{[^}]*\}/g, ' X ').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The dashboard's client script lives inside a template literal.
//    A backtick anywhere in it ends the literal and breaks the whole page —
//    which happened three times while building this, twice from a comment.
// ---------------------------------------------------------------------------

test('no backtick can get into the inlined client script', () => {
  const src = read('src/dashboard.js');
  const start = src.indexOf('<script nonce="${esc(nonce)}">\n// No key here');
  assert.ok(start > -1, 'the client script moved — update this guard');
  const script = src.slice(start, src.indexOf('</script>', start));

  const offenders = script.split('\n')
    .map((line, i) => [i, line])
    .filter(([, line]) => line.includes('`'));

  assert.deepEqual(offenders, [],
    'use String.fromCharCode(96) if the script genuinely needs a backtick');
});

// ---------------------------------------------------------------------------
// 2. A query against a table schema.sql does not create fails only at runtime,
//    on whichever page happens to run it. Both new tables shipped this way.
// ---------------------------------------------------------------------------

test('every table the code queries exists in schema.sql', () => {
  const declared = new Set(
    [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])
  );
  const missing = new Set();
  // Not tables: SQL keywords, the conflict clauses in "UPDATE OR IGNORE" and
  // "INSERT OR REPLACE INTO", and the placeholder interpolations are blanked to.
  const KEYWORDS = ['select', 'json_each', 'pragma_table_info', 'set', 'values',
    'or', 'ignore', 'replace', 'x'];

  // Only inside SQL string literals. Scanning whole files matches English prose
  // in comments — "inherited FROM strangers" is not a table.
  for (const [, src] of SRC) {
    for (const { sql } of sqlLiterals(src)) {
      for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)) {
        const t = m[1].toLowerCase();
        if (KEYWORDS.includes(t) || declared.has(t)) continue;
        missing.add(t);
      }
    }
  }
  assert.deepEqual([...missing], [], 'a table is queried that no fresh install has');
});

// ---------------------------------------------------------------------------
// 3. A query that forgets its profile filter returns plausible rows from the
//    other operation and nothing errors. Two shipped exactly like that.
//
//    Anything unscoped has to be listed here WITH A REASON. The point is not
//    that the list is empty — it is that adding to it is a deliberate act.
// ---------------------------------------------------------------------------

const SCOPED_TABLES = [
  'entities', 'outreach', 'feedback', 'lessons', 'runs', 'snapshots',
  'evaluations', 'crawl_frontier', 'keywords', 'source_cursor', 'budget',
  'skip_categories',
];

const ALLOWED_UNSCOPED = [
  {
    match: 'WHERE domain IN',
    why: 'discover.js: dedup is global, so a domain another profile already crawled '
       + 'can never become a lead here and re-fetching it would spend budget to find that out',
  },
  {
    match: "state = 'DO_NOT_CONTACT'",
    why: 'queue.js suppress(): an opt-out is a person\'s wish, not a profile\'s preference',
  },
  {
    match: 'WHERE X',
    why: 'the profile filter is built into an interpolated WHERE clause — dashboard '
       + 'history builds it from ["o.profile_id = ?", ...], asserted by test/isolation.test.js',
  },
  {
    match: 'UPDATE entities SET ${cols',
    why: 'addressed by primary key; the column list is what is interpolated, not the filter',
  },
  {
    match: 'SELECT o.id AS oid',
    why: 'dashboard history rows, same interpolated WHERE as the count above it',
  },
];

test('nothing queries a per-profile table without a profile, unexplained', () => {
  const anchored = /\b(?:id|entity_id|outreach_id|message_id|key)\s*(?:=\s*\?|IN\s*\()/i;
  const found = [];

  for (const [name, src] of SRC) {
    for (const { raw, sql } of sqlLiterals(src)) {
      if (sql.includes('profile_id') || anchored.test(sql)) continue;
      if (!SCOPED_TABLES.some((t) => new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`).test(sql))) continue;
      if (ALLOWED_UNSCOPED.some((a) => sql.includes(a.match) || raw.includes(a.match))) continue;
      found.push(`${name}: ${sql.slice(0, 110)}`);
    }
  }

  assert.deepEqual(found, [],
    'scope it to the profile, or add it to ALLOWED_UNSCOPED with the reason it is global');
});

// ---------------------------------------------------------------------------
// 4. Deleting a helper during a refactor breaks only the pages that call it.
//    An icon extraction silently removed siteLinks(), and only two suites
//    happened to cover a page that used it.
// ---------------------------------------------------------------------------

test('every page renders', async () => {
  const { renderDashboard, setupPage } = await import('../src/dashboard.js');
  const { docsIndex, docPage, docEditor, folderPage } = await import('../src/docsview.js');
  const { docTree, getDoc, childrenOf } = await import('../src/docs.js');

  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(`
    INSERT INTO profiles (id,slug,name,active,is_default,created_at,updated_at)
      VALUES ('p1','p1','One',1,1,'2026-01-01','2026-01-01');
    INSERT INTO entities (id,profile_id,display_name,domain,website,instagram,niche,
                          contact_email,score,state,location_text,first_seen_at,updated_at)
      VALUES ('e1','p1','Marlowe','marlowe.com','https://marlowe.com','marlowe','business',
              'a@marlowe.com',80,'CONTACTED','Portland, OR','2026-09-01','2026-09-01');
    INSERT INTO outreach (id,profile_id,entity_id,queue_date,rank,subject,body,status,created_at,sent_at)
      VALUES ('o1','p1','e1','2026-09-09',1,'s','b','DRAFT','2026-09-09',NULL),
             ('o2','p1','e1','2026-09-08',1,'s','b','SENT','2026-09-08','2026-09-08T10:00:00Z'),
             ('o3','p1','e1','2026-09-07',1,'s','b','SKIPPED','2026-09-07',NULL),
             ('o4','p1','e1','2026-09-06',1,'s','b','BOUNCED','2026-09-06',NULL);
  `);
  const runOne = (sql, args) => raw.prepare(sql).run(...args);
  const mk = (sql, args = []) => ({
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: runOne(sql, args).changes } }),
  });
  const db = { prepare: (sql) => ({ ...mk(sql), bind: (...a) => mk(sql, a) }) };

  const profile = { id: 'p1', slug: 'p1', name: 'One', niches: { business: { label: 'Business' } },
    personas: {}, metros: [] };
  const base = {
    nonce: 'n', day: '2026-09-09', page: 1, q: '', from: null, to: null,
    profile, profiles: [{ id: 'p1', slug: 'p1', name: 'One', is_default: 1, active: 1 }],
    env: {}, sending: { connected: true, sent_today: 1, daily_cap: 30 },
  };

  for (const view of ['today', 'sent', 'skipped', 'bounced', 'metrics', 'calendar']) {
    const html = await renderDashboard(db, {}, { ...base, view, calendar: { ok: true, bookings: [] } });
    assert.ok(html.startsWith('<!doctype html>'), `${view} did not render a page`);
    assert.ok(html.includes('</html>'), `${view} rendered a truncated page`);
    // A thrown-away helper shows up as the literal word "undefined" in the output.
    assert.ok(!/>undefined</.test(html), `${view} rendered an undefined value`);
  }

  const tree = await docTree(db, 'p1');
  const doc = await getDoc(db, 'p1', 'skips');
  for (const [label, body] of [
    ['docs index', docsIndex(tree)],
    ['a document', docPage(doc)],
    ['a folder', folderPage(tree.folders[0], await childrenOf(db, 'p1', tree.folders[0].id))],
    ['the editor', docEditor(doc, { folders: tree.folders, profiles: [] })],
    ['a new page', docEditor(null, { folders: tree.folders, profiles: [], isNew: true })],
  ]) {
    const html = await renderDashboard(db, {}, { ...base, view: 'docs', docsBody: body, docsTree: tree });
    assert.ok(html.includes('</html>'), `${label} did not render`);
    assert.ok(!/>undefined</.test(html), `${label} rendered an undefined value`);
  }

  assert.ok(setupPage({}, 'n').includes('</html>'), 'the first-run page did not render');
});

// ---------------------------------------------------------------------------
// 5. A profile created after a feature shipped was missing that feature's data,
//    so its chart was empty and the feature was invisible. Whatever setup
//    creates has to be complete on the day it is created.
// ---------------------------------------------------------------------------

test('a newly created profile is immediately usable', async () => {
  const { createProfile, resolveProfile } = await import('../src/profiles.js');
  const { listCategories } = await import('../src/categories.js');

  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const runOne = (sql, args) => raw.prepare(sql).run(...args);
  const mk = (sql, args = []) => ({
    sql, args,
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: runOne(sql, args).changes } }),
  });
  const db = {
    prepare: (sql) => ({ ...mk(sql), bind: (...a) => mk(sql, a) }),
    async batch(st) { return st.map((x) => ({ meta: { changes: runOne(x.sql, x.args).changes } })); },
  };

  const env = {
    AI: {
      run: async () => ({
        response: {
          ai_system: 'Judge dental practices.',
          seed_keywords: ['dental practice', 'orthodontist', 'family dentistry'],
          niches: [{
            slug: 'dental', label: 'Dental', keywords: ['dentist', 'implants', 'hygienist', 'crown', 'invisalign', 'patient'],
            persona_context: 'I build booking systems for clinics.',
            subject: '{name} — a note on your booking flow',
            osm: { amenity: ['dentist'], healthcare: ['dentist'], craft: [], shop: [], office: [] },
          }],
        },
      }),
    },
  };

  const made = await createProfile(env, db, {
    name: 'Clinics',
    brief: 'Independent dental practices in the United States with several staff of their own.',
  });
  assert.equal(made.ok, true, made.error);

  const p = await resolveProfile(db, made.slug);
  assert.ok(Object.keys(p.niches).length, 'it can classify a business');
  assert.ok(Object.keys(p.personas).length, 'it can write an email');
  assert.ok(p.aiSystem, 'it can score a lead');
  assert.ok(p.seedKeywords.length, 'it can discover one');
  assert.ok((await listCategories(db, made.id)).length, 'and it can sort a skip');

  const seeded = raw.prepare('SELECT COUNT(*) n FROM keywords WHERE profile_id = ?').get(made.id);
  assert.ok(seeded.n > 0, 'discovery starts on the next crawl, not after a manual step');
});
