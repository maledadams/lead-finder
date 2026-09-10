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
// 1b. The script the BROWSER receives has to parse.
//
//     dashboard.js parsing is not the same question. The client script is built
//     inside a template literal, so a backslash escape written there is consumed
//     before the browser sees it: `split('\\n')` in source became a string
//     containing a real newline in the output — valid JavaScript in the file,
//     a syntax error in the page. Every button died at once: settings would not
//     open, the profile switcher did nothing, no handler ran at all.
//
//     Checking the source cannot catch that. Only the output can.
// ---------------------------------------------------------------------------

test('the script the browser receives parses', async () => {
  const { renderDashboard, setupPage } = await import('../src/dashboard.js');

  const first = async () => ({ todo: 0, sent: 0, skipped: 0, bounced: 0, contacted: 0, n: 0 });
  const all = async () => ({ results: [] });
  const db = { prepare: () => ({ first, all, bind: () => ({ first, all }) }) };
  const profile = { id: 'p1', slug: 'p1', name: 'One', niches: {}, personas: {} };

  const pages = [];
  for (const view of ['today', 'sent', 'metrics']) {
    pages.push([view, await renderDashboard(db, {}, {
      view, nonce: 'n', day: '2026-09-09', page: 1, q: '', from: null, to: null,
      profile, profiles: [], env: {},
    })]);
  }
  pages.push(['setup', setupPage({}, 'n')]);

  for (const [label, html] of pages) {
    for (const m of html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)) {
      // new Function parses without executing, which is exactly the question.
      assert.doesNotThrow(() => new Function(m[1]),
        `${label}: the inlined script does not parse in a browser`);
    }
  }
});

// ---------------------------------------------------------------------------
// 1c. A closed <dialog> is hidden by the browser's own stylesheet, and ANY
//     author rule setting display overrides it. `.sheet.wide{display:flex}`
//     did, so the settings sheet rendered inline at the foot of every page —
//     always visible, never interactive.
// ---------------------------------------------------------------------------

test('a closed dialog is hidden, whatever else styles it', async () => {
  const { renderDashboard } = await import('../src/dashboard.js');
  const first = async () => ({ todo: 0, sent: 0, skipped: 0, bounced: 0, contacted: 0, n: 0 });
  const all = async () => ({ results: [] });
  const db = { prepare: () => ({ first, all, bind: () => ({ first, all }) }) };

  const html = await renderDashboard(db, {}, {
    view: 'today', nonce: 'n', day: '2026-09-09', page: 1, q: '', from: null, to: null,
    profile: { id: 'p1', slug: 'p1', name: 'One', niches: {} }, profiles: [], env: {},
  });

  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const hide = css.indexOf('dialog.sheet:not([open]){display:none}');
  assert.ok(hide > -1, 'nothing hides a closed dialog');

  // Every rule that gives a dialog a display must be beaten by that one.
  for (const m of css.matchAll(/\.sheet[^{}]*\{[^}]*display:[^};]+/g)) {
    assert.ok(hide < m.index || m[0].includes('[open]'),
      `a later rule sets display on a dialog and will show it closed: ${m[0].slice(0, 60)}`);
  }

  // And no dialog may ship with the open attribute already set.
  assert.equal((html.match(/<dialog[^>]*\sopen/g) || []).length, 0,
    'a dialog that starts open is a page with a sheet stuck to it');

  // The same trap catches [hidden]: it is only a UA rule, so any author rule
  // setting display beats it. The confirm dialog's typed-name field showed on
  // every delete for exactly that reason.
  assert.match(css, /\[hidden\]\{display:none!important\}/,
    'nothing forces [hidden] to stay hidden');
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

// ---------------------------------------------------------------------------
// 6. A placeholder that reaches a deploy is a live outage.
//
//    Genericising the repository, I replaced three deployment values with
//    REPLACE_WITH_ placeholders and restored two. The third was ZOHO_CLIENT_ID,
//    so every deploy for a day shipped a client id that does not exist and
//    sending failed with a bare "invalid client" — nothing in the app said why,
//    and no test could fail, because the value was syntactically fine.
// ---------------------------------------------------------------------------

test('no placeholder value can reach a deploy', () => {
  const toml = read('wrangler.toml');
  // A placeholder is only safe where the code RECOGNISES it and turns the
  // feature off. zohoConfigured() did not, which is how "invalid client"
  // reached the Send button. Anything listed here must be covered by such a
  // check; the list is empty because the credentials all moved to secrets.
  const HANDLED = [];

  const offenders = toml.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !line.trim().startsWith('#'))
    .filter(([, line]) => /REPLACE_WITH|YOUR-NAME|CHANGEME|xxxx/i.test(line))
    .filter(([, line]) => !HANDLED.some((k) => line.trim().startsWith(k)))
    .map(([i, line]) => `wrangler.toml:${i}: ${line.trim()}`);

  assert.deepEqual(offenders, [],
    'a placeholder in a deployed value breaks the thing it configures, silently');
});

test('no credential is committed to the repository', () => {
  const toml = read('wrangler.toml');
  const settings = toml.split('\n')
    .filter((l) => !l.trim().startsWith('#') && l.includes('='))
    .map((l) => l.split('=')[0].trim());

  // Anything that names or authenticates an account is a secret, set with
  // `wrangler secret put`, never a [vars] entry. The Zoho CLIENT ID is included
  // deliberately: it is not a password, but it names one specific application
  // and has no business in a public repository.
  const mustBeSecret = [
    'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'DASHBOARD_KEY', 'SESSION_SECRET',
    'CAL_API_KEY', 'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'SENDER_EMAIL',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  ];
  const leaked = mustBeSecret.filter((k) => settings.includes(k));
  assert.deepEqual(leaked, [], 'these belong in wrangler secret put, not in the config');

  // And no value anywhere that looks like a live credential.
  const shapes = [
    [/\b1000\.[A-Z0-9]{20,}\b/, 'a Zoho client id'],
    [/\bcal_live_[a-f0-9]{16,}\b/, 'a Cal.com key'],
    [/\b[0-9a-f]{32}\b/, 'a 32-hex token'],
  ];
  for (const [re, what] of shapes) {
    const hit = toml.split('\n').find((l) => !l.trim().startsWith('#') && re.test(l));
    assert.equal(hit, undefined, `${what} is committed: ${hit}`);
  }
});

test('a placeholder credential disables its feature instead of being used', async () => {
  const { zohoConfigured } = await import('../src/zoho.js');

  // The dashboard asks these before offering the button. Answering "yes" for a
  // placeholder is what turns a misconfiguration into "invalid client" at the
  // moment somebody presses Send.
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: 'REPLACE_WITH_YOUR_ZOHO_CLIENT_ID', ZOHO_CLIENT_SECRET: 'x' }), false);
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: '1000.ABCDEFGH', ZOHO_CLIENT_SECRET: 'CHANGEME' }), false);
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: '', ZOHO_CLIENT_SECRET: 'x' }), false);
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: '1000.ABCDEFGH', ZOHO_CLIENT_SECRET: 'real' }), true);

});
