import { test } from 'node:test';
import assert from 'node:assert/strict';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

test('scraped business names cannot inject mail headers', async () => {
  const { stripControl, displayName, composeDraft } = await import('../src/outreach.js');

  // display_name comes from a scraped <title> or og:site_name, so whoever
  // owns a crawled site chooses this string.
  assert.equal(stripControl(`Evil${LF}Bcc: victim@x.com`), 'Evil Bcc: victim@x.com');
  assert.equal(stripControl(`a${CR}${LF}b`), 'a b');
  // Control characters become a space rather than vanishing, so removing one
  // never silently glues two words together.
  assert.equal(stripControl(`with${NUL}null`), 'with null');
  assert.ok(!new RegExp(`[${CR}${LF}]`).test(displayName({ display_name: `Brand${CR}${LF}X: y` })));

  const d = composeDraft({
    niche: 'craft_goods',
    display_name: `Evil${LF}Bcc: victim@x.com`,
    contact_email: 'a@b.com',
    website_opportunity: 'no meta description',
    personalization: JSON.stringify({ liked: 'the ash-glazed vase collection' }),
  }, { SENDER_EMAIL: 'hi@x.com', SENDER_POSTAL_ADDRESS: '1 St' });

  assert.ok(!new RegExp(`[${CR}${LF}]`).test(d.subject), 'subject must never carry a line break');
  assert.ok(d.subject.length <= 200);
});

test('the send boundary refuses a malformed recipient regardless of caller', async () => {
  const { sendMail } = await import('../src/zoho.js');
  const env = { ZOHO_CLIENT_ID: 'x', ZOHO_CLIENT_SECRET: 'y' };
  const db = { prepare: () => ({ bind: () => ({ first: async () => ({ value: 'tok' }) }) }) };

  const bad = [
    `a@b.com${LF}Bcc: v@x.com`,
    'a@b.com, c@d.com',
    '<a@b.com>',
    'not-an-email',
    '',
  ];
  for (const to of bad) {
    const r = await sendMail(env, db, { to, subject: 's', body: 'b' });
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(to)}`);
    assert.equal(r.error, 'invalid-recipient');
  }
});

test('the email validator rejects addresses carrying line breaks', async () => {
  const { isUsableEmail } = await import('../src/extract.js');
  assert.ok(isUsableEmail('sasha@brand.com'));
  for (const bad of [`a@b.co${LF}`, `a@b.co${LF}Bcc: v@evil.com`, `a@b.com${CR}${LF}X: y`]) {
    assert.equal(isUsableEmail(bad), false, 'must not accept a newline in an address');
  }
});

test('a key-derived session is not treated as an allowlisted person', async () => {
  const { verifySession } = await import('../src/auth.js');
  const { createHmac } = await import('node:crypto');
  const ENV = { SESSION_SECRET: 'a-long-secret', ALLOWED_EMAILS: 'someone@else.com' };

  const mint = (subject) => {
    const p = Buffer.from(JSON.stringify({ e: subject, x: Date.now() + 60000 })).toString('base64url');
    return `${p}.${createHmac('sha256', ENV.SESSION_SECRET).update(p).digest('base64url')}`;
  };

  // The shared key is its own credential, so its session bypasses the email
  // allowlist by design...
  assert.equal(await verifySession(ENV, mint('dashboard-key')), 'dashboard-key');
  // ...but that must not become a way to forge an identity for anyone else.
  assert.equal(await verifySession(ENV, mint('stranger@evil.com')), null);
  assert.equal(await verifySession(ENV, mint('someone@else.com')), 'someone@else.com');
});
