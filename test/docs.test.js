// Documentation.
//
// The one thing that must never fail here is the renderer. A document is the
// only place in this system where a person's raw text becomes HTML on purpose,
// so it is the only place where markup could execute. Escaping first makes a
// <script> impossible — but marked will happily emit href="javascript:..." from
// ordinary link syntax, which escaping does nothing about. Both halves are
// asserted below, because I checked and the second one is a real hole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  childrenOf, deleteDoc, docTree, getDoc, renderMarkdown, saveDoc, visibleTo,
} from '../src/docs.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function fresh() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(`
    INSERT INTO profiles (id,slug,name,active,is_default,created_at,updated_at)
      VALUES ('p-creative','creative','Creative',1,1,'2026-01-01','2026-01-01'),
             ('p-medium','medium','Medium',1,0,'2026-01-02','2026-01-02')`);
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
// The renderer
// ---------------------------------------------------------------------------

test('markup in a document can never execute', () => {
  const out = renderMarkdown([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<div onclick="alert(1)">click</div>',
  ].join('\n\n'));

  assert.ok(!/<script/i.test(out), 'no script tag survives');
  assert.ok(!/<iframe/i.test(out), 'no iframe survives');
  assert.ok(!/<img[^>]*onerror/i.test(out), 'no event handler survives on a real tag');
  assert.match(out, /&lt;script&gt;/, 'it comes out as visible text instead');
});

test('a javascript: link is defused, and its words are kept', () => {
  // Escaping alone does NOT stop this — marked emits the href verbatim.
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)',
    'data:text/html,<h1>x', 'vbscript:msgbox']) {
    const out = renderMarkdown(`[click me](${bad})`);
    assert.ok(!/href=["']?\s*(javascript|data|vbscript)/i.test(out), `${bad} produced ${out}`);
    assert.match(out, /click me/, 'the text a person wrote is not deleted to make it safe');
  }
});

test('ordinary links and relative links still work', () => {
  const out = renderMarkdown('[a](https://example.com) [b](/docs/x) [c](mailto:x@y.com)');
  assert.match(out, /href="https:\/\/example\.com"/);
  assert.match(out, /href="\/docs\/x"/);
  assert.match(out, /href="mailto:x@y\.com"/);
  assert.match(out, /rel="noopener noreferrer"/, 'external links do not leak the referrer');
});

test('markdown renders as markdown', () => {
  const out = renderMarkdown('# Title\n\n- one\n- two\n\n**bold**');
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<li>one<\/li>/);
  assert.match(out, /<strong>bold<\/strong>/);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('the Skips page ships, in a folder, and reads as HTML', async () => {
  const { db } = fresh();
  const tree = await docTree(db, 'p-creative');
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].title, 'How it works');
  assert.equal(tree.folders[0].docs[0].title, 'Skips');

  const doc = await getDoc(db, 'p-creative', 'skips');
  const html = doc.body_html || renderMarkdown(doc.body_md);
  assert.match(html, /<h2>Skipping versus blocking<\/h2>/);
});

test('a page is rendered once, on save', async () => {
  const { raw, db } = fresh();
  const res = await saveDoc(db, { title: 'Notes', bodyMd: '# Hi\n\nthere' });
  assert.equal(res.ok, true);
  const row = raw.prepare('SELECT * FROM docs WHERE id = ?').get(res.id);
  assert.match(row.body_html, /<h1>Hi<\/h1>/, 'viewing it later parses nothing');
  assert.equal(row.body_md, '# Hi\n\nthere', 'and the source is kept to edit');
});

test('slugs do not collide', async () => {
  const { db } = fresh();
  const a = await saveDoc(db, { title: 'Notes', bodyMd: 'x' });
  const b = await saveDoc(db, { title: 'Notes', bodyMd: 'y' });
  assert.equal(a.slug, 'notes');
  assert.equal(b.slug, 'notes-2');
});

test('a page can be scoped to one profile, and is invisible to the other', async () => {
  const { db } = fresh();
  await saveDoc(db, { title: 'Medium only', bodyMd: 'x', scope: ['p-medium'] });

  assert.equal(await getDoc(db, 'p-creative', 'medium-only'), null);
  assert.ok(await getDoc(db, 'p-medium', 'medium-only'));

  const creative = await docTree(db, 'p-creative');
  assert.ok(!creative.loose.some((d) => d.slug === 'medium-only'));
});

test('an empty scope means every profile, not no profiles', async () => {
  const { db } = fresh();
  await saveDoc(db, { title: 'Shared', bodyMd: 'x', scope: [] });
  assert.ok(await getDoc(db, 'p-creative', 'shared'));
  assert.ok(await getDoc(db, 'p-medium', 'shared'));
  assert.equal(visibleTo({ profile_scope: null }, 'anything'), true);
  assert.equal(visibleTo({ profile_scope: 'not json' }, 'anything'), true, 'broken scope shows it');
});

test('deleting a folder takes its pages, and says how many', async () => {
  const { raw, db } = fresh();
  const folder = raw.prepare("SELECT id FROM docs WHERE slug='how-it-works'").get();
  const res = await deleteDoc(db, folder.id);

  assert.equal(res.ok, true);
  assert.equal(res.children, 1, 'the confirmation can say what a folder delete costs');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM docs').get().n, 0);
});

test('deleting a page leaves its folder alone', async () => {
  const { raw, db } = fresh();
  const doc = raw.prepare("SELECT id FROM docs WHERE slug='skips'").get();
  await deleteDoc(db, doc.id);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM docs').get().n, 1);
});

test('a folder page lists what is inside it', async () => {
  const { raw, db } = fresh();
  const folder = raw.prepare("SELECT id FROM docs WHERE slug='how-it-works'").get();
  const kids = await childrenOf(db, 'p-creative', folder.id);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].title, 'Skips');
});

test('a page needs a title', async () => {
  const { db } = fresh();
  assert.equal((await saveDoc(db, { title: ' ', bodyMd: 'x' })).ok, false);
});
