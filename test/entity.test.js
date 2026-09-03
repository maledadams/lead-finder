import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDomain, normalizeUrl, normalizeInstagram, normalizeTiktok,
  normalizeEtsy, normalizeName, identityKeys,
  slugVariants,
} from '../src/entity.js';

test('normalizeDomain strips scheme, www, path and port', () => {
  assert.equal(normalizeDomain('https://www.CuteBrand.com/shop?x=1'), 'cutebrand.com');
  assert.equal(normalizeDomain('cutebrand.com'), 'cutebrand.com');
  assert.equal(normalizeDomain('http://shop.cutebrand.com'), 'cutebrand.com');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain(''), null);
});

test('normalizeDomain keeps multi-part public suffixes intact', () => {
  assert.equal(normalizeDomain('https://shop.brand.co.uk'), 'brand.co.uk');
  assert.equal(normalizeDomain('brand.com.au'), 'brand.com.au');
});

test('normalizeUrl drops tracking params and fragments', () => {
  assert.equal(
    normalizeUrl('http://WWW.Brand.com/shop/?utm_source=ig&fbclid=xyz#top'),
    'https://brand.com/shop'
  );
  assert.equal(normalizeUrl('brand.com'), 'https://brand.com/');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
});

test('social handles normalize from url, @handle or bare', () => {
  assert.equal(normalizeInstagram('https://www.instagram.com/CuteBrandCo/'), 'cutebrandco');
  assert.equal(normalizeInstagram('@CuteBrandCo'), 'cutebrandco');
  assert.equal(normalizeInstagram('cutebrandco'), 'cutebrandco');
  assert.equal(normalizeTiktok('https://tiktok.com/@cutebrandco?lang=en'), 'cutebrandco');
  assert.equal(normalizeEtsy('https://www.etsy.com/shop/CuteBrandCo'), 'cutebrandco');
  assert.equal(normalizeEtsy('https://www.etsy.com/uk/shop/CuteBrandCo'), 'cutebrandco');
});

test('normalizeName strips legal suffixes and punctuation', () => {
  assert.equal(normalizeName('Cute Brand Co., LLC'), 'cute brand');
  assert.equal(normalizeName("Moon & Stars Studio"), 'moon and stars');
  assert.equal(normalizeName('X'), null);
});

test('identityKeys produces one key per identifier', () => {
  const { keys } = identityKeys({
    website: 'https://www.cute-brand.com',
    instagram: 'https://instagram.com/cutebrandco',
    tiktok: '@cutebrandco',
    etsy: 'https://etsy.com/shop/cutebrandco',
    display_name: 'Cute Brand Co.',
  });
  const set = new Set(keys.map((k) => k.key));
  assert.ok(set.has('domain:cute-brand.com'));
  assert.ok(set.has('instagram:cutebrandco'));
  assert.ok(set.has('tiktok:cutebrandco'));
  assert.ok(set.has('etsy:cutebrandco'));
  // A name key is only added when there is no stronger identifier.
  assert.ok(!set.has('name:cute brand'));
});

test('identityKeys falls back to a name key only when nothing stronger exists', () => {
  const { keys } = identityKeys({ display_name: 'Cute Brand Co.' });
  assert.deepEqual(keys.map((k) => k.kind), ['name']);
});

test('marketplace hosts never become a domain identity key', () => {
  const { keys } = identityKeys({ website: 'https://www.etsy.com/shop/thing' });
  assert.equal(keys.filter((k) => k.kind === 'domain').length, 0);
});

test('the four-profiles-one-business case produces overlapping keys', () => {
  // Site, IG, TikTok and Etsy discovered separately must share keys so the
  // resolver folds them into one entity.
  const fromSite = identityKeys({ website: 'https://cute-brand.com', instagram: '@cutebrandco' });
  const fromEtsy = identityKeys({ etsy: 'https://etsy.com/shop/cutebrandco', instagram: 'cutebrandco' });
  const a = new Set(fromSite.keys.map((k) => k.key));
  const b = new Set(fromEtsy.keys.map((k) => k.key));
  const shared = [...a].filter((k) => b.has(k));
  assert.ok(shared.includes('instagram:cutebrandco'), 'should share the instagram key');
});

test('slugVariants emits full and tail-stripped forms without over-collapsing', () => {
  assert.deepEqual(slugVariants('cute-brand'), ['cutebrand']);
  assert.deepEqual(slugVariants('cutebrandco'), ['cutebrandco', 'cutebrand']);
  assert.deepEqual(slugVariants('ab'), []);
  // "brand" must NOT be stripped - that would collapse to the generic "cute".
  assert.ok(!slugVariants('cutebrand').includes('cute'));
});

test('slug is a weak key, exact identifiers are strong', () => {
  const { strong, weak } = identityKeys({ website: 'https://cute-brand.com' });
  assert.deepEqual(strong.map((k) => k.kind), ['domain']);
  assert.ok(weak.every((k) => k.kind === 'slug'));
});

test('the four-door case shares a slug key', () => {
  const doors = [
    { website: 'cute-brand.com' },
    { instagram: 'https://instagram.com/cutebrandco' },
    { tiktok: 'https://tiktok.com/@cutebrandco' },
    { etsy: 'https://etsy.com/shop/cutebrandco' },
  ].map((d) => new Set(identityKeys(d).slugs));

  const shared = [...doors[0]].filter((s) => doors.every((d) => d.has(s)));
  assert.ok(shared.length >= 1, `expected a shared slug, got ${JSON.stringify(doors.map(d=>[...d]))}`);
  assert.ok(shared.includes('cutebrand'));
});

test('unrelated brands with a shared word do not share a slug', () => {
  const a = new Set(identityKeys({ website: 'moonstudio.com' }).slugs);
  const b = new Set(identityKeys({ website: 'moonbakery.com' }).slugs);
  assert.equal([...a].filter((s) => b.has(s)).length, 0);
});
