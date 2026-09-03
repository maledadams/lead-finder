// Place-based discovery via OpenStreetMap's Overpass API.
//
// WHY NOT GOOGLE MAPS
//
// Scraping Maps needs a browser (Workers has none) and is against Google's
// terms — out of scope under the project's own safety rules. The Places API
// is legitimate, and its free tier would cover this volume, but it requires a
// billing account with a card on file, which is not "$0, no paid APIs".
//
// Overpass gives the same axis — businesses by place and category — free, no
// API key, no login, no browser, and ODbL-licensed for exactly this kind of
// use. It is queryable directly from a Worker.
//
// It is genuinely complementary to the Certificate Transparency sweep:
//
//   CT logs  -> online-only brands, found by domain keyword, no location
//   OSM      -> physical creative businesses, found by place + category,
//               with a verified US street address
//
// That address matters more than it looks: "United States only" stops being
// an inference from page text and becomes a fact attached to the record
// before we ever fetch the site.
//
// HONEST LIMITS
//   - Coverage is uneven. Dense in cities, thin in small towns, and a shop
//     with no `website` tag is invisible to us.
//   - Overpass is volunteer-run infrastructure. It rate-limits and returns
//     503 under load. Every failure here is normal, never retried hard.
//   - It finds businesses with premises. Online-only brands are the CT
//     sweep's job.

import { normalizeDomain, nowIso } from './entity.js';

// Public Overpass instances, tried in order.
//
// These are volunteer-run and shed load unpredictably: the same query, sent
// twice seconds apart, was observed returning 504, then 406, then a clean
// result. So treat a failure as "this mirror is busy right now", move to the
// next, and never retry hard against any one of them.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const OVERPASS_TIMEOUT_MS = 45_000;

// Overpass gateways are fussy about User-Agent and reject some well-formed
// ones outright. A single bare token is the form that survives.
const OVERPASS_UA = 'LeadFinderBot/0.1';

/**
 * US metros, ordered by how dense they are in the kind of business Lucia
 * wants rather than by population. Each entry is [south, west, north, east].
 */
export const METROS = [
  ['portland-or',    [45.43, -122.84, 45.65, -122.47]],
  ['brooklyn-ny',    [40.62, -74.05, 40.74, -73.86]],
  ['los-angeles-ca', [33.98, -118.50, 34.15, -118.18]],
  ['austin-tx',      [30.19, -97.83, 30.40, -97.66]],
  ['oakland-ca',     [37.75, -122.32, 37.86, -122.16]],
  ['seattle-wa',     [47.53, -122.42, 47.70, -122.24]],
  ['chicago-il',     [41.85, -87.72, 41.98, -87.58]],
  ['nashville-tn',   [36.11, -86.85, 36.22, -86.70]],
  ['philadelphia-pa',[39.92, -75.24, 40.02, -75.12]],
  ['richmond-va',    [37.50, -77.53, 37.60, -77.40]],
  ['providence-ri',  [41.79, -71.46, 41.86, -71.37]],
  ['minneapolis-mn', [44.93, -93.32, 45.03, -93.21]],
  ['denver-co',      [39.68, -105.02, 39.79, -104.90]],
  ['atlanta-ga',     [33.72, -84.42, 33.81, -84.33]],
  ['new-orleans-la', [29.91, -90.13, 30.00, -90.02]],
  ['santa-fe-nm',    [35.63, -106.00, 35.71, -105.90]],
  ['asheville-nc',   [35.54, -82.61, 35.62, -82.52]],
  ['savannah-ga',    [32.02, -81.13, 32.10, -81.06]],
  ['burlington-vt',  [44.44, -73.24, 44.51, -73.18]],
  ['pittsburgh-pa',  [40.42, -80.03, 40.48, -79.92]],
  ['detroit-mi',     [42.32, -83.12, 42.40, -82.98]],
  ['san-diego-ca',   [32.70, -117.19, 32.79, -117.11]],
  ['boston-ma',      [42.33, -71.13, 42.39, -71.03]],
  ['bozeman-mt',     [45.65, -111.09, 45.71, -111.00]],
  ['hudson-ny',      [42.23, -73.80, 42.26, -73.76]],
  ['marfa-tx',       [30.28, -104.04, 30.32, -103.99]],
];

/**
 * Categories worth pulling. Deliberately excludes supermarkets, chains,
 * hardware and services — this is a creative-business filter, not a
 * business directory.
 */
// Tightened after a first pass on Portland and Brooklyn returned mostly
// ordinary local retail — florists, furniture showrooms, shoe shops. Those
// categories are dominated by businesses with no creative identity, so they
// are gone. What remains skews to maker-run and design-led premises.
const SHOP_TAGS = [
  'pottery', 'art', 'craft', 'jewelry', 'cosmetics', 'perfumery',
  'stationery', 'chocolate', 'coffee', 'tea', 'antiques', 'second_hand',
  'boutique', 'bag', 'music', 'photo', 'frame', 'candles', 'herbalist',
  'confectionery', 'clothes',
];

// craft=* values that are actual makers, not trades.
const CRAFT_TAGS = [
  'potter', 'jeweller', 'goldsmith', 'shoemaker', 'tailor', 'dressmaker',
  'basket_maker', 'bookbinder', 'candlemaker', 'glassblower', 'leather',
  'photographer', 'sculptor', 'painter', 'artist', 'printmaker', 'weaver',
  'upholsterer', 'distillery', 'brewery', 'winery', 'confectionery',
];

/** Map an OSM category onto the internal niche taxonomy. */
export function nicheForTags(tags) {
  const shop = tags.shop || '';
  const craft = tags.craft || '';

  if (['pottery', 'craft', 'houseware', 'candles'].includes(shop) ||
      ['potter', 'basket_maker', 'candlemaker', 'glassblower', 'weaver', 'bookbinder', 'leather'].includes(craft)) {
    return 'craft_goods';
  }
  if (shop === 'jewelry' || ['jeweller', 'goldsmith'].includes(craft)) return 'craft_goods';
  if (['cosmetics', 'perfumery', 'herbalist'].includes(shop)) return 'beauty_wellness';
  if (['bakery', 'chocolate', 'coffee', 'tea', 'deli', 'confectionery', 'health_food'].includes(shop) ||
      ['distillery', 'brewery', 'winery', 'confectionery'].includes(craft)) {
    return 'food_bev';
  }
  if (shop === 'art' || ['artist', 'sculptor', 'painter', 'printmaker', 'photographer'].includes(craft)) {
    return 'artist_portfolio';
  }
  if (['clothes', 'shoes', 'bag', 'second_hand', 'antiques', 'boutique'].includes(shop) ||
      ['tailor', 'dressmaker', 'shoemaker'].includes(craft)) {
    return 'alt_fashion';
  }
  if (shop === 'photo') return 'creative_studio';
  return 'lifestyle_brand';
}

function buildQuery([s, w, n, e]) {
  const bbox = `${s},${w},${n},${e}`;
  const shops = SHOP_TAGS.join('|');
  const crafts = CRAFT_TAGS.join('|');
  return `[out:json][timeout:50];(` +
    `nwr["shop"~"^(${shops})$"]["website"](${bbox});` +
    `nwr["craft"~"^(${crafts})$"]["website"](${bbox});` +
    `);out center 400;`;
}

/**
 * Query one metro. Returns candidate records, or [] on any failure.
 */
export async function queryMetro(metro, bbox, _userAgent) {
  const query = encodeURIComponent(buildQuery(bbox));
  const attempts = [];

  for (const mirror of OVERPASS_MIRRORS) {
    let payload;
    try {
      // No Accept header on purpose: Overpass serves `application/osm3s+json`
      // and some gateways answer an explicit `application/json` with a 406.
      const res = await fetch(`${mirror}?data=${query}`, {
        headers: { 'User-Agent': OVERPASS_UA },
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (!res.ok) { attempts.push(`${host(mirror)}:${res.status}`); continue; }
      payload = await res.json();
    } catch (err) {
      attempts.push(`${host(mirror)}:${err?.name === 'TimeoutError' ? 'timeout' : 'error'}`);
      continue;
    }

    if (!payload?.elements) { attempts.push(`${host(mirror)}:shape`); continue; }
    return { candidates: toCandidates(payload.elements, metro), error: null, mirror: host(mirror) };
  }

  return { candidates: [], error: `all-mirrors-failed(${attempts.join(',')})` };
}

const host = (u) => { try { return new URL(u).hostname.split('.')[0]; } catch { return u; } };

/**
 * Turn Overpass elements into seed candidates, dropping chains and anything
 * without a usable independent website.
 */
export function toCandidates(elements, metro) {
  const out = [];
  const seen = new Set();

  for (const el of elements) {
    const tags = el?.tags || {};
    if (isChain(tags)) continue;

    const site = tags.website || tags['contact:website'];
    const domain = normalizeDomain(site);
    if (!domain || seen.has(domain)) continue;

    // A US address in the tags is far better evidence than page text.
    const state = tags['addr:state'] || null;
    const city = tags['addr:city'] || null;

    seen.add(domain);
    out.push({
      website: `https://${domain}`,
      domain,
      display_name: tags.name || null,
      niche: nicheForTags(tags),
      location_text: [city, state].filter(Boolean).join(', ') || metro,
      country: 'US',
      contact_email: tags.email || tags['contact:email'] || null,
      contact_source: tags.email || tags['contact:email'] ? 'osm' : null,
      instagram: tags['contact:instagram'] || null,
      discovery_source: `osm:${metro}`,
      osm_category: tags.shop || tags.craft || null,
    });
  }
  return out;
}

/**
 * Chain detection. OSM tags chains explicitly, which makes this deterministic
 * rather than a guess: `brand:wikidata` in particular is only present on
 * recognised multi-location brands.
 */
export function isChain(tags) {
  // OSM's own chain markers, when present, are authoritative.
  if (tags['brand:wikidata'] || tags['brand:wikipedia']) return true;
  if (tags.wikidata || tags.wikipedia) return true;
  if (tags.brand && tags.name && tags.brand !== tags.name) return true;
  if (tags.operator && tags.operator !== tags.name) return true;

  // But plenty of chains are simply untagged. A first pass let through Tandy
  // Leather, Big Frog, Rocket Fizz, Dania and Scandinavian Designs, all of
  // which OSM had no brand tag for. These catch the shape of a franchise.
  const name = (tags.name || '').toLowerCase();
  if (/\b(inc|llc|corp|corporation|franchise|outlet|superstore|warehouse)\b/.test(name)) return true;
  // "Store #42", "Shop No. 7". No \b before '#' — it is not a word character,
  // so there is never a boundary there.
  if (/#\s?\d+|\bno\.\s?\d+\b/.test(name)) return true;

  return false;
}

/**
 * Cross-metro chain detection.
 *
 * The cleanest signal available and it needs no list to maintain: one domain
 * appearing as a storefront in several different cities is a chain, whatever
 * its tags say. Run after a few metros have been swept.
 */
export async function flagCrossMetroChains(db, minMetros = 3) {
  const { results } = await db
    .prepare(
      `SELECT domain, COUNT(DISTINCT discovery_source) AS metros
       FROM entities
       WHERE domain IS NOT NULL AND discovery_source LIKE 'osm:%'
       GROUP BY domain
       HAVING metros >= ?`
    )
    .bind(minMetros)
    .all();

  const chains = (results || []).map((r) => r.domain);
  if (!chains.length) return { flagged: 0, domains: [] };

  await db
    .prepare(
      `UPDATE entities
       SET state = 'REJECTED', reject_reason = 'chain:multi-metro', updated_at = ?
       WHERE domain IN (${chains.map(() => '?').join(',')})
         AND state NOT IN ('CONTACTED','REPLIED','CONVERSATION','CLIENT')`
    )
    .bind(nowIso(), ...chains)
    .run();

  return { flagged: chains.length, domains: chains };
}

/** Least-recently-queried metros first, so coverage rotates. */
export async function nextMetros(db, limit) {
  const { results } = await db
    .prepare("SELECT keyword, last_run_at FROM source_cursor WHERE keyword LIKE 'osm:%'")
    .all();
  const seen = new Map((results || []).map((r) => [r.keyword, r.last_run_at]));

  return METROS
    .map(([metro, bbox]) => ({ metro, bbox, key: `osm:${metro}` }))
    .sort((a, b) => (seen.get(a.key) || '').localeCompare(seen.get(b.key) || ''))
    .slice(0, limit);
}

export async function recordMetroRun(db, metro, found) {
  await db
    .prepare(
      `INSERT INTO source_cursor (keyword, last_run_at, total_found, runs)
       VALUES (?,?,?,1)
       ON CONFLICT(keyword) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         total_found = total_found + excluded.total_found,
         runs = runs + 1`
    )
    .bind(`osm:${metro}`, nowIso(), found)
    .run();
}
