import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedEmails, googleConfigured, verifySession, readCookie } from '../src/auth.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec',
  SESSION_SECRET: 'a-long-random-session-secret-value',
  ALLOWED_EMAILS: 'owner@example.com, teammate@example.com ',
};

test('the allowlist is parsed, trimmed and lowercased', () => {
  assert.deepEqual(allowedEmails(ENV), ['owner@example.com', 'teammate@example.com']);
  assert.deepEqual(allowedEmails({}), []);
});

test('google sign-in is only considered configured when fully configured', () => {
  assert.equal(googleConfigured(ENV), true);
  assert.equal(googleConfigured({ ...ENV, GOOGLE_CLIENT_SECRET: '' }), false);
  assert.equal(googleConfigured({ ...ENV, SESSION_SECRET: '' }), false);
  assert.equal(googleConfigured({}), false);
});

test('a forged or tampered session is rejected', async () => {
  assert.equal(await verifySession(ENV, null), null);
  assert.equal(await verifySession(ENV, 'garbage'), null);
  assert.equal(await verifySession(ENV, 'a.b'), null);

  // A correctly shaped payload with a wrong signature must fail.
  const payload = Buffer.from(JSON.stringify({
    e: 'owner@example.com', x: Date.now() + 60000,
  })).toString('base64url');
  assert.equal(await verifySession(ENV, `${payload}.notarealsignature`), null);
});

test('an expired session is rejected even with a valid signature', async () => {
  const { createHmac } = await import('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    e: 'owner@example.com', x: Date.now() - 1000,     // already expired
  })).toString('base64url');
  const sig = createHmac('sha256', ENV.SESSION_SECRET).update(payload).digest('base64url');
  assert.equal(await verifySession(ENV, `${payload}.${sig}`), null);
});

test('a valid session for an allowed email is accepted', async () => {
  const { createHmac } = await import('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    e: 'owner@example.com', x: Date.now() + 600000,
  })).toString('base64url');
  const sig = createHmac('sha256', ENV.SESSION_SECRET).update(payload).digest('base64url');
  assert.equal(await verifySession(ENV, `${payload}.${sig}`), 'owner@example.com');
});

test('removing someone from the allowlist locks them out immediately', async () => {
  const { createHmac } = await import('node:crypto');
  // A perfectly valid, unexpired session...
  const payload = Buffer.from(JSON.stringify({
    e: 'oliver@example.com', x: Date.now() + 600000,
  })).toString('base64url');
  const sig = createHmac('sha256', ENV.SESSION_SECRET).update(payload).digest('base64url');
  const token = `${payload}.${sig}`;

  // ...is accepted while listed, and refused the moment they are removed,
  // without waiting for the cookie to expire.
  assert.equal(await verifySession({ ...ENV, ALLOWED_EMAILS: 'oliver@example.com' }, token), 'oliver@example.com');
  assert.equal(await verifySession(ENV, token), null);
});

test('cookies are read by exact name', () => {
  const req = { headers: { get: () => '__Host-lf_session=abc; other=x' } };
  assert.equal(readCookie(req, '__Host-lf_session'), 'abc');
  assert.equal(readCookie(req, 'lf_session'), null);
  assert.equal(readCookie({ headers: { get: () => '' } }, 'x'), null);
});
