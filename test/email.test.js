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
