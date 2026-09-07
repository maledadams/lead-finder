import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedEmails, googleConfigured, verifySession, readCookie } from '../src/auth.js';

const ENV = {
  GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-csec',
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

test('placeholder Google credentials count as not configured', () => {
  const base = { SESSION_SECRET: 'x', ALLOWED_EMAILS: 'a@b.com' };
  // These were live in production and produced a sign-in button that could
  // only ever fail.
  assert.equal(googleConfigured({ ...base,
    GOOGLE_CLIENT_ID: 'REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID',
    GOOGLE_CLIENT_SECRET: 'placeholder-set-me' }), false);
  // A real client id always carries Google's suffix.
  assert.equal(googleConfigured({ ...base,
    GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-realsecret' }), true);
  // A plausible-looking but wrong id (e.g. a pasted UUID) is refused.
  assert.equal(googleConfigured({ ...base,
    GOOGLE_CLIENT_ID: '6b0b2f2a-f92e-460e-b76e-57af536fd14d',
    GOOGLE_CLIENT_SECRET: 'something' }), false);
});

test('Zoho is only considered usable with real credentials', async () => {
  const { zohoConfigured, ZOHO_SCOPES, authorizeUrl } = await import('../src/zoho.js');
  assert.equal(zohoConfigured({}), false);
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: 'x' }), false);
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: 'x', ZOHO_CLIENT_SECRET: 'y' }), true);

  // Only the two scopes needed to send. Nothing that can read existing mail.
  assert.equal(ZOHO_SCOPES, 'ZohoMail.accounts.READ,ZohoMail.messages.CREATE');
  assert.ok(!/ALL|DELETE|UPDATE|folders/i.test(ZOHO_SCOPES));

  // offline access is what yields a refresh token; without it sending stops
  // working an hour after setup.
  const u = authorizeUrl({ ZOHO_CLIENT_ID: 'cid' }, 'https://x.test/cb', 's');
  assert.match(u, /access_type=offline/);
  assert.match(u, /accounts\.zoho\.com/);

  // Regions route to the right data centre.
  assert.match(authorizeUrl({ ZOHO_CLIENT_ID: 'c', ZOHO_REGION: 'eu' }, 'https://x.test/cb', 's'),
    /accounts\.zoho\.eu/);
});
