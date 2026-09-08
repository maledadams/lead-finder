import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { canReceiveMail } from '../src/mx.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

/** A database plus a fetch that answers DNS without touching the network. */
function harness(answers) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const run = (sql, args) => raw.prepare(sql).run(...args);
  const mk = (sql, args = []) => ({
    first: async () => raw.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: run(sql, args).changes } }),
  });
  const db = { prepare: (sql) => ({ ...mk(sql), bind: (...a) => mk(sql, a) }) };

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls += 1;
    const u = new URL(url);
    const key = `${u.searchParams.get('name')}:${u.searchParams.get('type')}`;
    const body = answers[key] ?? answers['*'] ?? { Status: 3 };
    if (body instanceof Error) throw body;
    return { ok: true, json: async () => body };
  };
  return { raw, db, calls: () => calls, restore: () => { globalThis.fetch = realFetch; } };
}

const MX_OK = { Status: 0, Answer: [{ type: 15, data: '10 mail.example.com.' }] };
const NXDOMAIN = { Status: 3 };
const NO_RECORDS = { Status: 0, Answer: [] };

test('a domain with MX records can be written to', async () => {
  const h = harness({ 'brand.com:MX': MX_OK });
  try {
    const r = await canReceiveMail(h.db, 'hello@brand.com');
    assert.equal(r.deliverable, true);
    assert.match(r.detail, /^mx:/);
  } finally { h.restore(); }
});

test('a domain that does not exist is refused', async () => {
  // Every one of these is a real address from the bounce log.
  for (const email of ['connect@antik.brooklyn', 'cre@ivity.get', 'calculated@checkout.duties']) {
    const h = harness({ '*': NXDOMAIN });
    try {
      const r = await canReceiveMail(h.db, email);
      assert.equal(r.deliverable, false, `${email} must be refused`);
      assert.equal(r.detail, 'nxdomain');
    } finally { h.restore(); }
  }
});

test('no MX but a usable address record still accepts mail', async () => {
  // RFC 5321: the A record is an implicit mail exchanger. Refusing these would
  // drop real leads.
  const h = harness({
    'brand.com:MX': NO_RECORDS,
    'brand.com:A': { Status: 0, Answer: [{ type: 1, data: '203.0.113.7' }] },
  });
  try {
    const r = await canReceiveMail(h.db, 'hello@brand.com');
    assert.equal(r.deliverable, true);
    assert.equal(r.detail, 'implicit-mx:a');
  } finally { h.restore(); }
});

test('a domain with neither MX nor an address record is refused', async () => {
  const h = harness({ '*': NO_RECORDS });
  try {
    const r = await canReceiveMail(h.db, 'hello@brand.com');
    assert.equal(r.deliverable, false);
    assert.equal(r.detail, 'no-mx-no-address');
  } finally { h.restore(); }
});

test('the answer is cached, so a domain is looked up once', async () => {
  const h = harness({ 'brand.com:MX': MX_OK });
  try {
    await canReceiveMail(h.db, 'hello@brand.com');
    const before = h.calls();
    const second = await canReceiveMail(h.db, 'someone-else@brand.com');
    assert.equal(h.calls(), before, 'a cached domain must not be looked up again');
    assert.equal(second.cached, true);
    assert.equal(second.deliverable, true);
  } finally { h.restore(); }
});

test('a DNS failure fails OPEN and is not cached', async () => {
  // A wrong "no" would silently empty the morning queue; a wrong "yes" costs
  // one bounce. The cheaper mistake is the one to make.
  const h = harness({ '*': new Error('network down') });
  try {
    const r = await canReceiveMail(h.db, 'hello@brand.com');
    assert.equal(r.deliverable, true, 'an unreachable DNS server must not block sending');
    assert.match(r.detail, /lookup-failed/);
    assert.equal(h.raw.prepare('SELECT COUNT(*) n FROM mx_cache').get().n, 0,
      'a failure must not be cached as an answer');
  } finally { h.restore(); }
});

test('a malformed address is refused without a lookup', async () => {
  const h = harness({ '*': MX_OK });
  try {
    for (const bad of ['', null, 'not-an-email', 'a@', '@b.com']) {
      const r = await canReceiveMail(h.db, bad);
      assert.equal(r.deliverable, false, `${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(h.calls(), 0, 'nothing malformed should reach DNS');
  } finally { h.restore(); }
});
