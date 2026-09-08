import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { syncBounces } from '../src/bounces.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

/**
 * A database plus a fake Zoho. The label lookup and the message list are the
 * only two calls syncBounces makes, so both are answered from a fixture.
 */
function harness({ messages = [], labelOk = true, listOk = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(`
    INSERT INTO app_settings (key, value, updated_at)
      VALUES ('zoho_account_id','acct','2026-01-01'),
             ('zoho_access_token','tok','2026-01-01'),
             ('zoho_access_expires','${Date.now() + 3600_000}','2026-01-01'),
             ('zoho_refresh_token','r','2026-01-01');
    INSERT INTO entities (id, profile_id, display_name, domain, contact_email, state, first_seen_at, updated_at)
      VALUES ('e1','p-creative','Fenwick','fenwick.com','hello@fenwick.com','CONTACTED','2026-01-01','2026-01-01'),
             ('e2','p-creative','Marlowe','marlowe.com','studio@marlowe.com','CONTACTED','2026-01-01','2026-01-01');
    INSERT INTO outreach (id, profile_id, entity_id, queue_date, rank, subject, body, status, created_at, sent_at)
      VALUES ('o1','p-creative','e1','2026-01-01',1,'s','b','SENT','2026-01-01','2026-01-01T10:00:00Z'),
             ('o2','p-creative','e2','2026-01-01',2,'s','b','SENT','2026-01-01','2026-01-01T10:00:00Z');
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

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/labels')) {
      if (!labelOk) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [{ labelId: '99', displayName: 'Bounce' }] }) };
    }
    if (u.includes('/messages/view')) {
      if (!listOk) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: messages }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { raw, db, restore: () => { globalThis.fetch = realFetch; } };
}

const env = { ZOHO_CLIENT_ID: 'x', ZOHO_CLIENT_SECRET: 'y', ZOHO_BOUNCE_LABEL: 'bounce' };

test('a bounce notice naming a lead marks that lead bounced', async () => {
  const h = harness({ messages: [{
    messageId: 'm1',
    subject: 'Delivery Status Notification (Failure)',
    summary: 'Your message to hello@fenwick.com could not be delivered. 550 user unknown.',
  }] });
  try {
    const r = await syncBounces(env, h.db);
    assert.equal(r.matched, 1);
    assert.equal(r.bounced, 1);

    const o = h.raw.prepare("SELECT status FROM outreach WHERE id='o1'").get();
    assert.equal(o.status, 'BOUNCED');

    const e = h.raw.prepare("SELECT contact_email, state FROM entities WHERE id='e1'").get();
    assert.equal(e.contact_email, null, 'the dead address must be cleared');
    assert.equal(e.state, 'NURTURE', 'the business goes back in the pool');
    assert.notEqual(e.state, 'DO_NOT_CONTACT');

    // The other lead must be untouched.
    assert.equal(h.raw.prepare("SELECT status FROM outreach WHERE id='o2'").get().status, 'SENT');
  } finally { h.restore(); }
});

test('the same notice is never processed twice', async () => {
  const msg = {
    messageId: 'm1', subject: 'Failure',
    summary: 'hello@fenwick.com could not be delivered',
  };
  const h = harness({ messages: [msg] });
  try {
    const first = await syncBounces(env, h.db);
    assert.equal(first.bounced, 1);

    const second = await syncBounces(env, h.db);
    assert.equal(second.bounced, 0, 'already handled');
    assert.equal(second.skipped, 1);
  } finally { h.restore(); }
});

test('a notice naming nobody we wrote to is recorded, not guessed at', async () => {
  const h = harness({ messages: [{
    messageId: 'm9', subject: 'Undeliverable',
    summary: 'Your message to someone@astranger.com bounced.',
  }] });
  try {
    const r = await syncBounces(env, h.db);
    assert.equal(r.matched, 0);
    assert.equal(r.bounced, 0);
    assert.equal(r.unmatched.length, 1);

    // Nothing may be marked on a guess.
    assert.equal(h.raw.prepare("SELECT COUNT(*) n FROM outreach WHERE status='BOUNCED'").get().n, 0);
    // But it is remembered, so it is not re-examined forever.
    assert.equal(h.raw.prepare("SELECT outcome FROM bounce_seen WHERE message_id='m9'").get().outcome, 'unmatched');
  } finally { h.restore(); }
});

test('a missing scope is reported rather than thrown', async () => {
  // The existing Zoho grant predates messages.READ, so this is the state a live
  // install is in until it reconnects. It must not take the cron down.
  const h = harness({ labelOk: false });
  try {
    const r = await syncBounces(env, h.db);
    assert.match(r.error, /reconnect Zoho/);
    assert.equal(r.bounced, 0);
  } finally { h.restore(); }
});

test('an empty label does nothing at all', async () => {
  const h = harness({ messages: [] });
  try {
    const r = await syncBounces(env, h.db);
    assert.equal(r.scanned, 0);
    assert.equal(r.bounced, 0);
    assert.equal(r.error, undefined);
  } finally { h.restore(); }
});
