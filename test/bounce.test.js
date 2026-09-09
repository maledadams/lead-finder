import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markBounced, revive } from '../src/queue.js';
import { stripControlKeepLines, hasCanSpamFooter, canSpamFooter } from '../src/outreach.js';

/**
 * A D1 stub that records what was asked of it, in the style of
 * test/injection.test.js. Enough to assert the shape of a write without
 * standing up a database.
 */
function stubDb({ first = {}, changes = 1 } = {}) {
  const calls = [];
  const stmt = (sql) => ({
    bind: (...args) => {
      const rec = { sql, args };
      return {
        ...rec,
        first: async () => (typeof first === 'function' ? first(sql, args) : first),
        run: async () => { calls.push(rec); return { meta: { changes } }; },
      };
    },
  });
  return {
    calls,
    batched: [],
    prepare(sql) { return stmt(sql); },
    async batch(statements) {
      this.batched.push(...statements);
      calls.push(...statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

const sqlOf = (db) => db.calls.map((c) => c.sql.replace(/\s+/g, ' ')).join(' || ');

test('markBounced clears the address so the crawler can refill it', async () => {
  const db = stubDb({ first: { entity_id: 'e1', status: 'SENT', contact_email: 'dead@brand.com' } });
  const res = await markBounced(db, 'o1', '550 user unknown');

  assert.equal(res.ok, true);
  assert.equal(res.cleared, 'dead@brand.com');

  const entityUpdate = db.calls.find((c) => c.sql.includes('UPDATE entities'));
  assert.ok(entityUpdate, 'the entity must be updated');
  assert.match(entityUpdate.sql, /contact_email = NULL/);
  assert.match(entityUpdate.sql, /contact_source = NULL/);

  // NULL is what makes queue.js skip it and pipeline.js COALESCE refill it.
  // Those two lines are the whole mechanism; if this assertion goes, so does
  // "eliminated from the roster unless it finds the actual mail address".
  assert.match(entityUpdate.sql, /state = 'NURTURE'/);
});

test('markBounced never sets DO_NOT_CONTACT', async () => {
  const db = stubDb({ first: { entity_id: 'e1', status: 'SENT', contact_email: 'dead@brand.com' } });
  await markBounced(db, 'o1', 'mailbox full');

  // Routing a bounce through suppress() would set DO_NOT_CONTACT and make the
  // removal permanent, which is the opposite of what a bounce means.
  assert.doesNotMatch(sqlOf(db), /DO_NOT_CONTACT/);
});

test('markBounced suppresses the dead address under its own key', async () => {
  const db = stubDb({ first: { entity_id: 'e1', status: 'SENT', contact_email: 'Dead@Brand.com' } });
  await markBounced(db, 'o1', '550 user unknown');

  const sup = db.calls.find((c) => c.sql.includes('INTO suppressions'));
  assert.ok(sup, 'the dead address must be suppressed');
  assert.equal(sup.args[0], 'Dead@Brand.com');
  assert.match(sup.args[1], /^bounced: /);
});

test('markBounced guards contact history against a second successful send', async () => {
  const db = stubDb({ first: { entity_id: 'e1', status: 'SENT', contact_email: 'dead@brand.com' } });
  await markBounced(db, 'o1', 'bounced');

  const entityUpdate = db.calls.find((c) => c.sql.includes('UPDATE entities'));
  // Only null the timestamps when no OTHER outreach row is still SENT — the
  // bounced row was moved off SENT by the statement before this one.
  assert.match(entityUpdate.sql, /first_contacted_at = CASE WHEN NOT EXISTS/);
  assert.match(entityUpdate.sql, /last_contacted_at = CASE WHEN NOT EXISTS/);
  assert.match(entityUpdate.sql, /status = 'SENT'/);
});

test('markBounced tolerates a row with no address on file', async () => {
  const db = stubDb({ first: { entity_id: 'e1', status: 'SENT', contact_email: null } });
  const res = await markBounced(db, 'o1', 'bounced');

  assert.equal(res.ok, true);
  assert.equal(res.cleared, null);
  assert.equal(db.calls.filter((c) => c.sql.includes('INTO suppressions')).length, 0);
});

test('markBounced reports a missing outreach row', async () => {
  const db = stubDb({ first: null });
  assert.deepEqual(await markBounced(db, 'nope', 'x'), { ok: false, error: 'not-found' });
});

test('revive refuses to reopen a sent email', async () => {
  const db = stubDb({ first: { entity_id: 'e1', status: 'SENT' } });
  assert.deepEqual(await revive(db, 'o1'), { ok: false, error: 'already-sent' });
});

test('revive reports the unique-index collision instead of failing silently', async () => {
  // idx_outreach_unique (entity_id, queue_date) means UPDATE OR IGNORE quietly
  // does nothing when the business already has a draft today.
  const db = stubDb({ first: { entity_id: 'e1', status: 'SKIPPED' }, changes: 0 });
  assert.deepEqual(await revive(db, 'o1'), { ok: false, error: 'already-queued-today' });
});

// ---------------------------------------------------------------------------
// The two sanitisers that stand between an edited draft and a sent email.
// ---------------------------------------------------------------------------

test('stripControlKeepLines keeps the line breaks that stripControl destroys', () => {
  const body = 'Hi Ada,\r\n\r\nI saw your glaze series.\n\nBest,\nRowan';
  assert.equal(stripControlKeepLines(body), 'Hi Ada,\n\nI saw your glaze series.\n\nBest,\nRowan');
});

test('stripControlKeepLines removes header-injection characters', () => {
  // Written as escapes on purpose: a literal control byte in a source file
  // is invisible in review and survives copy-paste as whitespace.
  assert.equal(stripControlKeepLines('Brand\u0000\u0007name'), 'Brand name');
  assert.equal(stripControlKeepLines('tab\tseparated'), 'tab separated');
  assert.doesNotMatch(stripControlKeepLines('a\rBcc: victim@x.com'), /\r/);
  assert.equal(stripControlKeepLines('keep\nthe\nlines'), 'keep\nthe\nlines');
});

test('stripControlKeepLines caps runaway blank lines and trailing spaces', () => {
  assert.equal(stripControlKeepLines('a   \n\n\n\n\nb'), 'a\n\nb');
  assert.equal(stripControlKeepLines('  padded  '), 'padded');
});

test('hasCanSpamFooter sees both required parts, or reports missing', () => {
  const env = { SENDER_POSTAL_ADDRESS: '12 Bell Row, Bristol BS1 4TY' };
  const good = `Hello,\n\nSome text.${canSpamFooter(env)}`;

  assert.equal(hasCanSpamFooter(good, env), true);
  // Opt-out present, address deleted.
  assert.equal(hasCanSpamFooter(good.replace(env.SENDER_POSTAL_ADDRESS, ''), env), false);
  // Address present, opt-out deleted.
  assert.equal(hasCanSpamFooter(`Hello,\n\n${env.SENDER_POSTAL_ADDRESS}`, env), false);
  assert.equal(hasCanSpamFooter('Hello, nice glazes.', env), false);
});
