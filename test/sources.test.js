import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractApexDomains, isPlausibleBrandDomain, allKeywords } from '../src/sources.js';

test('isPlausibleBrandDomain keeps brands, drops industrial suppliers', () => {
  assert.ok(isPlausibleBrandDomain('emiliaceramics.com'));
  assert.ok(isPlausibleBrandDomain('provinceapothecary.com'));
  assert.ok(isPlausibleBrandDomain('moth-and-moon.studio'));

  assert.ok(!isPlausibleBrandDomain('carboceramics-industrial.com'), 'industrial supplier');
  assert.ok(!isPlausibleBrandDomain('ceramics-engineering.com'), 'engineering firm');
  assert.ok(!isPlausibleBrandDomain('ohmi.co.jp'), 'non-allowed TLD');
  assert.ok(!isPlausibleBrandDomain('abc.com'), 'too short');
  assert.ok(!isPlausibleBrandDomain('123ceramics.com'), 'starts with a digit');
  assert.ok(!isPlausibleBrandDomain('store12345.com'), 'looks like a dev store');
});

test('extractApexDomains takes apex domains only and dedupes', () => {
  const certs = [
    { name_value: 'emiliaceramics.com\nwww.emiliaceramics.com' },
    { name_value: 'shop.emiliaceramics.com' },
    { name_value: '*.wildcard-ceramics.com' },
    { name_value: 'ceramics-engineering.com' },
    { name_value: 'asburyceramics.com' },
  ];
  const out = extractApexDomains(certs, 'ceramics');
  assert.ok(out.includes('emiliaceramics.com'));
  assert.ok(out.includes('asburyceramics.com'));
  assert.ok(!out.includes('shop.emiliaceramics.com'), 'subdomains excluded');
  assert.ok(!out.some((d) => d.includes('*')), 'wildcards excluded');
  assert.ok(!out.includes('ceramics-engineering.com'), 'industrial excluded');
  assert.equal(new Set(out).size, out.length, 'no duplicates');
});

test('the bootstrap keyword list is small, unique, and covers every niche', () => {
  // Small on purpose. This list only has to get a fresh database moving; the
  // real vocabulary is harvested into the `keywords` table. Every term here
  // has measured crt.sh yield rather than being invented.
  const all = allKeywords();
  const words = all.map((k) => k.keyword);
  assert.equal(new Set(words).size, words.length, 'keywords must be unique');
  assert.equal(new Set(all.map((k) => k.niche)).size, 7, 'every niche seeded');

  // The subcultures Lucia named explicitly must be reachable from a cold start.
  for (const must of ['lolita', 'emo', 'kawaii', 'harajuku', 'goth', 'decora']) {
    assert.ok(words.includes(must), `bootstrap must include "${must}"`);
  }
});

test('the free name filter catches what it cheaply can', () => {
  // These carry an explicit country or trade word in the domain, so they can
  // be dropped without paying for a fetch.
  for (const bad of ['saudiceramics.com', 'milfordceramictile.com', 'ceramics-engineering.com']) {
    assert.ok(!isPlausibleBrandDomain(bad), `should reject ${bad}`);
  }
});

test('names that look like brands are left for the content filter', () => {
  // "rakceramics.com" and "carboceramics.com" are industrial suppliers, but
  // nothing in the string says so. Rejecting them here would mean rejecting
  // real brands with the same shape. They are caught after the fetch, by
  // detectNonUS and the corporate markers in score.js. The filters are
  // layered on purpose - this is not a gap.
  for (const ambiguous of ['rakceramics.com', 'carboceramics.com', 'landmarkceramics.com']) {
    assert.ok(isPlausibleBrandDomain(ambiguous), `${ambiguous} is not name-filterable`);
  }
});

test('genuine indie brands still pass the filter', () => {
  for (const good of [
    'emiliaceramics.com', 'provinceapothecary.com', 'asburyapothecary.com',
    'laughinggoddessapothecary.com', 'mothandmoon.studio', 'heathceramics.com',
  ]) {
    assert.ok(isPlausibleBrandDomain(good), `should accept ${good}`);
  }
});
