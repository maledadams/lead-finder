import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeObfuscated, isUsableEmail } from '../src/extract.js';

// ---------------------------------------------------------------------------
// The decoder used to invent addresses out of ordinary prose.
//
// Every separator in the old pattern could match nothing, so a bare "at"
// inside a word was enough. These are the real sentences behind addresses
// that were actually emailed and actually bounced.
// ---------------------------------------------------------------------------

test('ordinary prose does not become an email address', () => {
  const sentences = [
    ['Shipping calculated at checkout. Duties and taxes apply.', 'calculated@checkout.duties'],
    ['Prices shown at checkout. Shop now.', 'shown@checkout.shop'],
    ['A studio built on creativity. Get in touch.', 'cre@ivity.get'],
    ['Book a consultation. Book online today.', 'consult@ion.book'],
    ['For more information. April hours vary.', 'inform@ion.april'],
    ['Great whiskey. And more.', 'gre@whiskey.and'],
    ['We love the weather. Make time for it.', 'we@her.make'],
    ['Across generations. Summer opening.', 'gener@ions.summer'],
    ['Weekly updates. Email us to join.', 'upd@es.email'],
    ['Visit creativity.com for more', 'cre@ivity.com'],
    ['See our location.com page', 'loc@ion.com'],
  ];
  for (const [text, used_to_produce] of sentences) {
    assert.deepEqual(decodeObfuscated(text), [], `"${text}" must yield nothing (was ${used_to_produce})`);
  }
});

test('a plainly written "at" with a plain dot is a sentence, not an address', () => {
  // The ambiguous case. Real obfuscation spells out "dot" or brackets it;
  // this is just English, and reading it as an address invents a recipient.
  assert.deepEqual(decodeObfuscated('Our latest collection at studio.com'), []);
  assert.deepEqual(decodeObfuscated('Find us at brand.com'), []);
});

test('genuine obfuscation is still decoded', () => {
  assert.deepEqual(decodeObfuscated('hello (at) brand (dot) com'), ['hello@brand.com']);
  assert.deepEqual(decodeObfuscated('hello [at] brand [dot] com'), ['hello@brand.com']);
  assert.deepEqual(decodeObfuscated('hello {at} brand.com'), ['hello@brand.com']);
  assert.deepEqual(decodeObfuscated('ada at fenwickash dot co'), ['ada@fenwickash.co']);
  assert.deepEqual(decodeObfuscated('studio (at) marlowe.com'), ['studio@marlowe.com']);
});

// ---------------------------------------------------------------------------
// Nothing validated the top-level domain, so the first word of the next
// sentence became one.
// ---------------------------------------------------------------------------

test('an implausible top-level domain is refused', () => {
  for (const e of ['cre@ivity.get', 'consult@ion.book', 'calculated@checkout.duties',
    'of@tention.if', 'we@her.make', 'connect@antik.brooklyn', 'organiz@ions.please']) {
    assert.equal(isUsableEmail(e), false, `${e} must be refused`);
  }
});

test('real addresses on real domains still pass', () => {
  for (const e of ['hello@brand.com', 'ada@fenwickash.co.uk', 'studio@marlowe.io',
    'hi@shop.store', 'team@brand.design', 'a@b.fr', 'x@y.at', 'q@r.is']) {
    assert.equal(isUsableEmail(e), true, `${e} must be accepted`);
  }
});

test('a two-letter TLD is only allowed if it is a real country code', () => {
  assert.equal(isUsableEmail('a@b.at'), true, '.at is Austria');
  assert.equal(isUsableEmail('a@b.is'), true, '.is is Iceland');
  assert.equal(isUsableEmail('a@b.if'), false, '.if is not a country');
  assert.equal(isUsableEmail('a@b.of'), false, '.of is not a country');
});

// ---------------------------------------------------------------------------
// The ambiguous form: prose and obfuscation are shaped identically.
// ---------------------------------------------------------------------------

test('a spaced "at" with a spelled "dot" is not an address when the local part is a stopword', () => {
  // "email me at hello dot com" is a sentence; "hi at brand dot com" is an
  // address. The only thing separating them is whether the local part could
  // plausibly be a mailbox.
  assert.deepEqual(decodeObfuscated('Email me at hello dot com'), []);
  assert.deepEqual(decodeObfuscated('Find us at studio dot com'), []);
  assert.deepEqual(decodeObfuscated('We are located at brand dot com'), []);
  assert.deepEqual(decodeObfuscated('Available at shop dot com'), []);
});

test('brackets are unambiguous, so a stopword local part is still accepted there', () => {
  // Someone who writes "me (at) brand (dot) com" plainly means an address.
  assert.deepEqual(decodeObfuscated('me (at) brand (dot) com'), ['me@brand.com']);
  assert.deepEqual(decodeObfuscated('us [at] brand [dot] com'), ['us@brand.com']);
});

test('a plausible mailbox name still decodes in the spaced form', () => {
  assert.deepEqual(decodeObfuscated('hi at brand dot com'), ['hi@brand.com']);
  assert.deepEqual(decodeObfuscated('ada at fenwickash dot co'), ['ada@fenwickash.co']);
});

// ---------------------------------------------------------------------------
// The footer is where a small business puts the address it wants used.
// ---------------------------------------------------------------------------

test('a footer address leads the list, ahead of one higher up the page', async () => {
  const { extractSignals } = await import('../src/extract.js');
  const html = `<html><body>
    <header><a href="mailto:careers@brand.com">Jobs</a></header>
    <main><p>Order questions: orders@brand.com</p></main>
    <footer><p>Say hello — <a href="mailto:hello@brand.com">hello@brand.com</a></p></footer>
  </body></html>`;
  const s = extractSignals(html, 'https://brand.com');

  assert.equal(s.emails[0], 'hello@brand.com', 'the footer address must come first');
  assert.deepEqual(s.footer_emails, ['hello@brand.com']);
  // Everything is still collected — ordering decides ties, it does not discard.
  assert.ok(s.emails.includes('orders@brand.com'));
  assert.ok(s.emails.includes('careers@brand.com'));
});

test('a footer marked up with a class rather than <footer> is still read', async () => {
  const { extractSignals } = await import('../src/extract.js');
  const html = `<html><body>
    <main><p>careers@brand.com</p></main>
    <div class="site-footer"><p>hello@brand.com</p></div>
  </body></html>`;
  const s = extractSignals(html, 'https://brand.com');
  assert.equal(s.emails[0], 'hello@brand.com');
});

test('a site with no marked-up footer still has its tail read', async () => {
  const { footerRegion } = await import('../src/extract.js');
  const body = `<html><body>${'<p>filler</p>'.repeat(200)}<p>hello@brand.com</p></body></html>`;
  assert.match(footerRegion(body), /hello@brand\.com/);
});

test('footer addresses are still subject to every other rule', async () => {
  const { extractSignals } = await import('../src/extract.js');
  // An invented address in a footer is still invented.
  const html = '<html><body><footer><p>Shipping calculated at checkout. Duties apply.</p></footer></body></html>';
  assert.deepEqual(extractSignals(html, 'https://brand.com').emails, []);
});
