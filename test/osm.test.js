import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChain, nicheForTags, toCandidates, METROS } from '../src/osm.js';

test('chains are detected deterministically from OSM tags', () => {
  assert.ok(isChain({ name: 'H&M', 'brand:wikidata': 'Q188326' }));
  assert.ok(isChain({ name: 'Starbucks', brand: 'Starbucks Coffee' }));
  assert.ok(isChain({ name: 'Local Shop', operator: 'Big Retail Group' }));
  assert.ok(!isChain({ name: "Ken's Artisan Bakery" }));
  assert.ok(!isChain({ name: 'Fifty24Pdx Gallery', website: 'https://fifty24pdx.com' }));
});

test('OSM categories map onto the niche taxonomy', () => {
  assert.equal(nicheForTags({ shop: 'pottery' }), 'craft_goods');
  assert.equal(nicheForTags({ craft: 'jeweller' }), 'craft_goods');
  assert.equal(nicheForTags({ shop: 'cosmetics' }), 'beauty_wellness');
  assert.equal(nicheForTags({ shop: 'bakery' }), 'food_bev');
  assert.equal(nicheForTags({ craft: 'brewery' }), 'food_bev');
  assert.equal(nicheForTags({ shop: 'art' }), 'artist_portfolio');
  assert.equal(nicheForTags({ shop: 'clothes' }), 'alt_fashion');
  assert.equal(nicheForTags({ shop: 'unknown_thing' }), 'lifestyle_brand');
});

test('toCandidates drops chains, dedupes domains, keeps US address', () => {
  const els = [
    { tags: { name: "Ken's Artisan Bakery", shop: 'bakery', website: 'https://kensartisan.com/bakery',
              'addr:city': 'Portland', 'addr:state': 'OR' } },
    { tags: { name: 'H&M', shop: 'clothes', website: 'https://www.hm.com/', 'brand:wikidata': 'Q188326' } },
    // same domain again, different node - must not double up
    { tags: { name: "Ken's Artisan", shop: 'bakery', website: 'https://kensartisan.com/' } },
    { tags: { name: 'No Site', shop: 'art' } },
  ];
  const out = toCandidates(els, 'portland-or');

  assert.equal(out.length, 1, 'one usable independent business');
  assert.equal(out[0].domain, 'kensartisan.com');
  assert.equal(out[0].niche, 'food_bev');
  assert.equal(out[0].country, 'US');
  assert.equal(out[0].location_text, 'Portland, OR');
  assert.equal(out[0].discovery_source, 'osm:portland-or');
});

test('metro bboxes are well formed', () => {
  assert.ok(METROS.length >= 20);
  for (const [name, [s, w, n, e]] of METROS) {
    assert.ok(s < n, `${name}: south must be below north`);
    assert.ok(w < e, `${name}: west must be left of east`);
    assert.ok(s > 24 && n < 50, `${name}: latitude outside the continental US`);
    assert.ok(w > -125 && e < -66, `${name}: longitude outside the continental US`);
  }
});

test('untagged franchises are caught by name shape', () => {
  // All of these slipped through a first pass because OSM had no brand tag.
  assert.ok(isChain({ name: 'Some Outlet' }));
  assert.ok(isChain({ name: 'Bargain Warehouse' }));
  assert.ok(isChain({ name: 'Coffee Co Store #42' }));
  assert.ok(isChain({ name: 'Acme Inc' }));
  assert.ok(isChain({ name: 'Local Gallery', wikidata: 'Q123' }), 'notable enough for wikidata');

  // ...without catching genuine independents.
  assert.ok(!isChain({ name: "Ken's Artisan Bakery" }));
  assert.ok(!isChain({ name: 'Moth & Moon Studio' }));
  assert.ok(!isChain({ name: 'Fifty24Pdx Gallery' }));
});

test('service businesses are rejected even when tagged as craft', async () => {
  const { toCandidates } = await import('../src/osm.js');
  // Every one of these came back from a real Brooklyn sweep tagged craft=tailor.
  const els = [
    'Mulberry Cleaners', 'Yes Cleaners', 'Coleman Cleaners', 'JSK Cleaners',
    'Dunrite Cleaners', "Mario's French Cleaners", 'Eden Dry Cleaners & Tailoring',
    'Lucky U Cleaners', 'LNC Tailor Shop', 'Fulton Cobbler',
  ].map((name) => ({ tags: { name, craft: 'tailor', 'contact:instagram': '@x' } }));

  assert.equal(toCandidates(els, 'brooklyn-ny').length, 0, 'no service shops should survive');
});

test('genuine makers without a website still come through', async () => {
  const { toCandidates } = await import('../src/osm.js');
  const els = [
    { tags: { name: 'Palm Jewelry', shop: 'jewelry', 'contact:instagram': '@palmjewelry',
              phone: '+17182847699', 'addr:city': 'Brooklyn', 'addr:state': 'NY' } },
    { tags: { name: 'Brooklyn Rockwerks', craft: 'sculptor', 'contact:instagram': '@rockwerks' } },
  ];
  const out = toCandidates(els, 'brooklyn-ny');
  assert.equal(out.length, 2);
  assert.equal(out[0].has_website, false);
  assert.equal(out[0].niche, 'craft_goods');
  assert.equal(out[1].niche, 'artist_portfolio');
});
