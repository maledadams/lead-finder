import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChain, nicheForTags, osmSpecFor, toCandidates, METROS } from '../src/osm.js';

/**
 * A profile's own taxonomy, standing in for whatever a real one defines.
 *
 * These used to be constants in src/osm.js, which meant every clone of this
 * repository inherited one person's idea of which shops are worth finding. The
 * mapping is now per profile, so the test brings its own.
 */
const PROFILE = {
  niches: {
    ceramics: { label: 'Ceramics', osm: { shop: ['pottery'], craft: ['potter'], amenity: [], healthcare: [], office: [] } },
    food: { label: 'Food', osm: { shop: ['bakery'], craft: ['brewery'], amenity: [], healthcare: [], office: [] } },
    clinics: { label: 'Clinics', osm: { amenity: ['dentist'], healthcare: ['physiotherapist'], craft: [], shop: [], office: [] } },
  },
  discovery: { social: true, exclude_names: '\\b(?:cleaners?|laundr)' },
};
const SPEC = osmSpecFor(PROFILE);

test('chains are detected deterministically from OSM tags', () => {
  assert.ok(isChain({ name: 'H&M', 'brand:wikidata': 'Q188326' }));
  assert.ok(isChain({ name: 'Starbucks', brand: 'Starbucks Coffee' }));
  assert.ok(isChain({ name: 'Local Shop', operator: 'Big Retail Group' }));
  assert.ok(!isChain({ name: "Ken's Artisan Bakery" }));
  assert.ok(!isChain({ name: 'Fifty24Pdx Gallery', website: 'https://fifty24pdx.com' }));
});

test('a business is filed under the category that claimed its tag', () => {
  assert.equal(nicheForTags({ shop: 'pottery' }, SPEC), 'ceramics');
  assert.equal(nicheForTags({ craft: 'potter' }, SPEC), 'ceramics');
  assert.equal(nicheForTags({ shop: 'bakery' }, SPEC), 'food');
  assert.equal(nicheForTags({ craft: 'brewery' }, SPEC), 'food');
  assert.equal(nicheForTags({ amenity: 'dentist' }, SPEC), 'clinics');
  assert.equal(nicheForTags({ healthcare: 'physiotherapist' }, SPEC), 'clinics');
  // Anything unclaimed falls to the profile's first category rather than to a
  // slug from somebody else's taxonomy.
  assert.equal(nicheForTags({ shop: 'unknown_thing' }, SPEC), 'ceramics');
});

test('a profile with no OSM tags ships no taxonomy of its own', () => {
  const bare = osmSpecFor(null);
  assert.equal(bare.byNiche, null, 'nothing is built in');
  assert.deepEqual(Object.values(bare.tags).flat(), [], 'and nothing is searched for');
  assert.equal(bare.nameFilter, null);
  assert.equal(bare.social, false, 'a lead with a phone and no website is not excluded by default');
});

test('a broken exclusion pattern is ignored rather than thrown', () => {
  const spec = osmSpecFor({ niches: {}, discovery: { exclude_names: '([unclosed' } });
  assert.equal(spec.nameFilter, null, 'a bad regex typed into Settings must not stop a crawl');
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
  const out = toCandidates(els, 'portland-or', SPEC);

  assert.equal(out.length, 1, 'one usable independent business');
  assert.equal(out[0].domain, 'kensartisan.com');
  assert.equal(out[0].niche, 'food');
  assert.equal(out[0].country, 'US');
  assert.equal(out[0].location_text, 'Portland, OR');
  assert.equal(out[0].discovery_source, 'osm:portland-or');
});

test('metro bboxes are well formed', () => {
  assert.ok(METROS.length >= 1000, 'the whole country, not a handful of cities');
  for (const [name, [s, w, n, e]] of METROS) {
    assert.ok(s < n, `${name}: south must be below north`);
    assert.ok(w < e, `${name}: west must be left of east`);
    // Alaska and Hawaii included, so this is the whole country rather than the
    // lower 48. A box in the sea is the failure this is really guarding against.
    assert.ok(s > 18 && n < 72, `${name}: latitude outside the United States`);
    assert.ok(w > -180 && e < -66, `${name}: longitude outside the United States`);
    // A box wider than about 40 km means Overpass will truncate the answer.
    assert.ok(n - s < 0.45, `${name}: box too tall — Overpass would truncate`);
  }
});

test('every state is somewhere in the list', async () => {
  const { METROS_BY_STATE } = await import('../src/metros.js');
  const states = Object.keys(METROS_BY_STATE);
  assert.equal(states.length, 51, 'fifty states and the District of Columbia');
  for (const st of states) {
    assert.ok(METROS_BY_STATE[st].length >= 1, `${st} has no cities`);
    // Every box must carry its state, so a metro key says where it is.
    for (const [name] of METROS_BY_STATE[st]) {
      assert.ok(new RegExp(`-${st}(-\\d+)?$`).test(name), `${name} is not tagged ${st}`);
    }
  }
  assert.equal(new Set(METROS.map((m) => m[0])).size, METROS.length, 'names must be unique');
  assert.equal(METROS.length, states.reduce((n, st) => n + METROS_BY_STATE[st].length, 0));
});

test('the sweep order visits different states straight away', () => {
  // Grouped alphabetically and walked in order, the first month of crawling
  // would never leave Alabama. The first few boxes must be in different states.
  const first = METROS.slice(0, 8).map(([n]) => n.replace(/-\d+$/, '').slice(-2));
  assert.equal(new Set(first).size, 8, `expected 8 different states, got ${first}`);
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

test("a profile's own name filter rejects what its tags let through", () => {
  // OSM tags dry cleaners as craft=tailor, so a search for makers returns them
  // by the dozen. Which names to exclude is a judgement about one operation, so
  // it belongs to the profile — here, the exclude_names in PROFILE above.
  const els = [
    'Mulberry Cleaners', 'Yes Cleaners', 'Eden Dry Cleaners & Tailoring', 'Lucky U Laundry',
  ].map((name) => ({ tags: { name, shop: 'pottery', 'contact:instagram': '@x' } }));

  assert.equal(toCandidates(els, 'brooklyn-ny', SPEC).length, 0, 'none should survive');
  // And with no filter configured, nothing is excluded on a hunch.
  assert.equal(toCandidates(els, 'brooklyn-ny', osmSpecFor({ niches: PROFILE.niches })).length, 4);
});

test('genuine makers without a website still come through', async () => {
  const { toCandidates } = await import('../src/osm.js');
  const els = [
    { tags: { name: 'Palm Ceramics', shop: 'pottery', 'contact:instagram': '@palmceramics',
              phone: '+17182847699', 'addr:city': 'Brooklyn', 'addr:state': 'NY' } },
    { tags: { name: 'Rockwerks Bakery', shop: 'bakery', 'contact:instagram': '@rockwerks' } },
  ];
  const out = toCandidates(els, 'brooklyn-ny', SPEC);
  assert.equal(out.length, 2);
  assert.equal(out[0].has_website, false);
  assert.equal(out[0].niche, 'ceramics');
  assert.equal(out[1].niche, 'food');
});
