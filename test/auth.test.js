import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedEmails, verifySession, readCookie } from '../src/auth.js';

const ENV = {
  GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-csec',
  SESSION_SECRET: 'a-long-random-session-secret-value',
  ALLOWED_EMAILS: 'owner@example.com, teammate@example.com ',
};

test('the allowlist is parsed, trimmed and lowercased', () => {
  assert.deepEqual(allowedEmails(ENV), ['owner@example.com', 'teammate@example.com']);
  assert.deepEqual(allowedEmails({}), []);
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


test('Zoho is only considered usable with real credentials', async () => {
  const { zohoConfigured, ZOHO_SCOPES, authorizeUrl } = await import('../src/zoho.js');
  assert.equal(zohoConfigured({}), false);
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: 'x' }), false);
  assert.equal(zohoConfigured({ ZOHO_CLIENT_ID: 'x', ZOHO_CLIENT_SECRET: 'y' }), true);

  // Exactly the scopes needed and no more. messages.READ was added so bounce
  // notices in a mailbox label can be detected automatically; it is read-only.
  assert.equal(
    ZOHO_SCOPES,
    'ZohoMail.accounts.READ,ZohoMail.messages.CREATE,ZohoMail.messages.READ'
  );
  // Nothing may ever modify or delete existing mail.
  assert.ok(!/ALL|DELETE|UPDATE|folders/i.test(ZOHO_SCOPES));
  for (const scope of ZOHO_SCOPES.split(',')) {
    assert.match(scope, /\.(READ|CREATE)$/, `${scope} must be read-only or create-only`);
  }

  // offline access is what yields a refresh token; without it sending stops
  // working an hour after setup.
  const u = authorizeUrl({ ZOHO_CLIENT_ID: 'cid' }, 'https://x.test/cb', 's');
  assert.match(u, /access_type=offline/);
  assert.match(u, /accounts\.zoho\.com/);

  // Regions route to the right data centre.
  assert.match(authorizeUrl({ ZOHO_CLIENT_ID: 'c', ZOHO_REGION: 'eu' }, 'https://x.test/cb', 's'),
    /accounts\.zoho\.eu/);
});

test('an unset SESSION_SECRET fails with something a person can act on', async () => {
  const { exchangeKeyForSession } = await import('../src/auth.js');
  // This is the path a new install hits first: open the dashboard with ?key=,
  // and the key is swapped for a session cookie. With no SESSION_SECRET set,
  // WebCrypto answers "Imported HMAC key length (0) must be a non-zero value…",
  // which sends someone looking at their crypto rather than their config.
  // Signing with an empty secret would be worse: every cookie forgeable.
  await assert.rejects(() => exchangeKeyForSession({}, 'https://x.test/?key=a'),
    /SESSION_SECRET/);
  // Only the empty case is refused. A short secret is weak but functional, and
  // rejecting it would lock an existing deployment out on its next deploy.
  const short = await exchangeKeyForSession({ SESSION_SECRET: 'short' }, 'https://x.test/?key=a');
  assert.equal(short.status, 302, 'a weak but working secret is not broken by this check');

  // And a real one still works.
  const good = await exchangeKeyForSession(
    { SESSION_SECRET: 'a-long-enough-secret-value' }, 'https://x.test/?key=a'
  );
  assert.equal(good.status, 302, 'a configured install still signs people in');
});

test('there is no sign-in of our own left to configure', async () => {
  // Cloudflare Access IS the login. The Google flow behind it was unreachable
  // and only added two more credentials for somebody to fill in.
  const auth = await import('../src/auth.js');
  for (const gone of ['googleConfigured', 'startLogin', 'completeLogin', 'loginPage']) {
    assert.equal(auth[gone], undefined, gone + ' should have gone with the Google flow');
  }
  // What the key-for-cookie exchange needs is still here.
  for (const kept of ['verifySession', 'sessionFrom', 'exchangeKeyForSession', 'logout', 'allowedEmails']) {
    assert.equal(typeof auth[kept], 'function', kept + ' is still used');
  }
});
