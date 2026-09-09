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
 * Where to look. Grouped by state in metros.js, walked as one interleaved list.
 *
 * Re-exported here because this module is where the OSM query lives and every
 * caller already imports from it. The list itself is 1,100+ boxes covering all
 * fifty states, which is a data file rather than something to read in the middle
 * of the query builder.
 */
export { METROS, METROS_BY_STATE } from './metros.js';

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
//
// `tailor`, `dressmaker`, `shoemaker` and `upholsterer` were here and had to
// go: in practice OSM uses them for dry cleaners, alteration counters and
// repair shops. A single Brooklyn sweep returned Mulberry Cleaners, Yes
// Cleaners, Coleman Cleaners, JSK Cleaners, Dunrite Cleaners, Eden Dry
// Cleaners and Lucky U Cleaners — all tagged as craft, none of them a
// creative business.
const CRAFT_TAGS = [
  'potter', 'jeweller', 'goldsmith', 'basket_maker', 'bookbinder',
  'candlemaker', 'glassblower', 'leather', 'photographer', 'sculptor',
  'painter', 'artist', 'printmaker', 'weaver', 'distillery', 'brewery',
  'winery', 'confectionery',
];

// Service businesses that slip through on category alone. Matched against the
// name, because the tagging does not distinguish them.
const NOT_CREATIVE = /\b(?:cleaners?|dry\s*clean|laundr|alterations?|tailor(?:ing|s)?|shoe\s*repair|cobbler|locksmith|barber|nail\s*salon|pharmacy|deli|bodega|smoke\s*shop|check\s*cashing|wireless|mobile\s*repair)\b/i;

// ---------------------------------------------------------------------------
// What a profile looks for
// ---------------------------------------------------------------------------

/**
 * The OSM search a profile performs, derived from its own niches.
 *
 * The creative profile has no stored configuration and gets the hand-tuned
 * lists above — every exclusion in them was earned by a bad sweep, and none of
 * it generalises to clinics or plumbers. A configured profile brings its own
 * tags per niche, which is also how a result is classified: the niche that
 * claimed the tag owns the lead.
 *
 * `social` is the real difference between the two populations. For a boutique
 * with no website, an Instagram IS the signal — it says the owner is
 * brand-conscious and has nowhere to send people. For a dental clinic it is
 * noise: a clinic with a phone and no website is exactly the lead, whether or
 * not anyone there posts. So the fallback contact tag differs.
 */
export function osmSpecFor(profile) {
  const niches = profile?.niches || {};
  const configured = Object.values(niches).some((n) => n?.osm);
  if (!configured) {
    return {
      tags: { shop: SHOP_TAGS, craft: CRAFT_TAGS, amenity: [], healthcare: [], office: [] },
      byNiche: null,
      social: true,
      nameFilter: NOT_CREATIVE,
      fallbackNiche: 'lifestyle_brand',
    };
  }

  const fields = ['amenity', 'healthcare', 'craft', 'shop', 'office'];
  const tags = Object.fromEntries(fields.map((f) => [f, []]));
  const byNiche = {};
  for (const [slug, n] of Object.entries(niches)) {
    byNiche[slug] = {};
    for (const f of fields) {
      const values = (Array.isArray(n?.osm?.[f]) ? n.osm[f] : []).map(String);
      byNiche[slug][f] = values;
      tags[f].push(...values);
    }
  }
  for (const f of fields) tags[f] = [...new Set(tags[f])];
  return {
    tags,
    byNiche,
    social: false,
    nameFilter: null,
    fallbackNiche: Object.keys(niches)[0] || null,
  };
}

/** Map an OSM category onto a profile's niche taxonomy. */
export function nicheForTags(tags, spec = osmSpecFor(null)) {
  // A configured profile classifies by its own tag lists, so a lead can only
  // ever land in a category that profile actually writes emails for.
  if (spec.byNiche) {
    for (const [slug, fields] of Object.entries(spec.byNiche)) {
      for (const [field, values] of Object.entries(fields)) {
        if (tags[field] && values.includes(tags[field])) return slug;
      }
    }
    return spec.fallbackNiche;
  }
  return creativeNiche(tags);
}

function creativeNiche(tags) {
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

/**
 * Two populations, both wanted, for different reasons.
 *
 * WITH a website: the site can be fetched, audited and scored on evidence.
 *
 * WITHOUT one, but with an Instagram or a maker trade: often the stronger
 * lead. A boutique with a real following and nowhere to send people has the
 * largest possible website opportunity, and knows it. Brooklyn alone returns
 * ~22 of these — independent boutiques, jewellers, vintage shops, a sculptor.
 *
 * A business with neither a site nor a social presence is skipped: there is
 * nothing to judge it on and no honest way to personalise an email.
 */
function buildQuery([s, w, n, e], spec) {
  const bbox = `${s},${w},${n},${e}`;
  // The contact tag a no-website lead must carry. See osmSpecFor(): Instagram
  // for the creative population, a phone number for service businesses.
  const reachable = spec.social ? '["contact:instagram"]' : '["phone"]';

  const clauses = [];
  for (const [field, values] of Object.entries(spec.tags)) {
    if (!values.length) continue;
    const alt = values.join('|');
    clauses.push(`nwr["${field}"~"^(${alt})$"]["website"](${bbox});`);
    clauses.push(`nwr["${field}"~"^(${alt})$"]["name"][!"website"]${reachable}(${bbox});`);
  }
  if (!clauses.length) return null;
  // 700, not 400: the boxes now cover a whole city rather than a downtown block,
  // and a truncated answer is indistinguishable from a thin one.
  return `[out:json][timeout:50];(${clauses.join('')});out center 700;`;
}

/**
 * Query one metro. Returns candidate records, or [] on any failure.
 */
export async function queryMetro(metro, bbox, _userAgent, spec = osmSpecFor(null)) {
  const built = buildQuery(bbox, spec);
  // A profile whose configuration names no OSM tags discovers by keyword only.
  // Saying so beats sending Overpass an empty union and reading nothing into
  // the zero results that come back.
  if (!built) return { candidates: [], error: 'no-osm-tags-for-profile' };
  const query = encodeURIComponent(built);
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
    return {
      candidates: toCandidates(payload.elements, metro, spec),
      error: null,
      mirror: host(mirror),
    };
  }

  return { candidates: [], error: `all-mirrors-failed(${attempts.join(',')})` };
}

const host = (u) => { try { return new URL(u).hostname.split('.')[0]; } catch { return u; } };

/**
 * Turn Overpass elements into seed candidates, dropping chains and anything
 * without a usable independent website.
 */
export function toCandidates(elements, metro, spec = osmSpecFor(null)) {
  const out = [];
  const seen = new Set();

  for (const el of elements) {
    const tags = el?.tags || {};
    if (isChain(tags)) continue;
    if (spec.nameFilter?.test(tags.name || '')) continue;

    const site = tags.website || tags['contact:website'];
    const domain = normalizeDomain(site);
    const instagram = tags['contact:instagram'] || tags.instagram || null;

    // No site: keep it only when there is another presence to judge and a way
    // to reach them. Otherwise there is nothing honest to say in an email.
    if (!domain) {
      if (!instagram && !tags.phone) continue;
      const key = `nosite:${(tags.name || '').toLowerCase()}:${tags['addr:street'] || ''}`;
      if (!tags.name || seen.has(key)) continue;
      seen.add(key);
      out.push({
        website: null,
        domain: null,
        display_name: tags.name,
        niche: nicheForTags(tags, spec),
        location_text: [tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ') || metro,
        country: 'US',
        contact_email: tags.email || tags['contact:email'] || null,
        contact_source: tags.email || tags['contact:email'] ? 'osm' : null,
        instagram,
        phone: tags.phone || tags['contact:phone'] || null,
        discovery_source: `osm:${metro}`,
        osm_category: tags.shop || tags.craft || tags.amenity || tags.healthcare || tags.office || null,
        osm_tags: compactTags(tags),
        has_website: false,
      });
      continue;
    }

    if (seen.has(domain)) continue;

    // A US address in the tags is far better evidence than page text.
    const state = tags['addr:state'] || null;
    const city = tags['addr:city'] || null;

    seen.add(domain);
    out.push({
      website: `https://${domain}`,
      domain,
      display_name: tags.name || null,
      niche: nicheForTags(tags, spec),
      location_text: [city, state].filter(Boolean).join(', ') || metro,
      country: 'US',
      contact_email: tags.email || tags['contact:email'] || null,
      contact_source: tags.email || tags['contact:email'] ? 'osm' : null,
      instagram,
      phone: tags.phone || tags['contact:phone'] || null,
      discovery_source: `osm:${metro}`,
      osm_category: tags.shop || tags.craft || tags.amenity || tags.healthcare || tags.office || null,
      osm_tags: compactTags(tags),
      has_website: true,
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
export async function flagCrossMetroChains(db, profileId, minMetros = 3) {
  if (!profileId) throw new Error('flagCrossMetroChains needs a profileId');
  const { results } = await db
    .prepare(
      `SELECT domain, COUNT(DISTINCT discovery_source) AS metros
       FROM entities
       WHERE profile_id = ? AND domain IS NOT NULL AND discovery_source LIKE 'osm:%'
       GROUP BY domain
       HAVING metros >= ?`
    )
    .bind(profileId, minMetros)
    .all();

  const chains = (results || []).map((r) => r.domain);
  if (!chains.length) return { flagged: 0, domains: [] };

  await db
    .prepare(
      `UPDATE entities
       SET state = 'REJECTED', reject_reason = 'chain:multi-metro', updated_at = ?
       WHERE profile_id = ?
         AND domain IN (${chains.map(() => '?').join(',')})
         AND state NOT IN ('CONTACTED','REPLIED','CONVERSATION','CLIENT')`
    )
    .bind(nowIso(), profileId, ...chains)
    .run();

  return { flagged: chains.length, domains: chains };
}

/**
 * The OSM tags worth keeping as evidence. For a business with no website
 * these are the only facts we will ever have, so they carry the scoring.
 */
const KEEP_TAGS = [
  'shop', 'craft', 'cuisine', 'opening_hours', 'phone', 'addr:street',
  'addr:city', 'addr:state', 'addr:postcode', 'contact:instagram',
  'description', 'wheelchair', 'payment:credit_cards', 'air_conditioning',
  'second_hand', 'organic', 'brand',
];

function compactTags(tags) {
  const out = {};
  for (const k of KEEP_TAGS) if (tags[k]) out[k] = String(tags[k]).slice(0, 200);
  return out;
}

/**
 * Metros due a sweep, least recently done first.
 *
 * `staleAfterHours` is what makes rotation work across the whole list: a metro
 * swept in the last day is skipped, so the two swept yesterday do not block
 * the twenty-four that have never been touched.
 */
export async function nextMetros(db, profileId, limit, staleAfterHours = 20, metros = null) {
  if (!profileId) throw new Error('nextMetros needs a profileId');
  const { results } = await db
    .prepare("SELECT keyword, last_run_at FROM source_cursor WHERE profile_id = ? AND keyword LIKE 'osm:%'").bind(profileId)
    .all();
  const seen = new Map((results || []).map((r) => [r.keyword, r.last_run_at]));
  const cutoff = new Date(Date.now() - staleAfterHours * 3600_000).toISOString();

  // The profile's own geography when it defines one, otherwise the national
  // list. This argument was being accepted and ignored, so a profile that
  // restricted itself to a few cities was silently swept nationwide.
  const list = Array.isArray(metros) && metros.length ? metros : METROS;

  return list
    .map(([metro, bbox]) => ({ metro, bbox, key: `osm:${metro}`, last: seen.get(`osm:${metro}`) || '' }))
    .filter((m) => !m.last || m.last < cutoff)
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(0, limit);
}

export async function recordMetroRun(db, profileId, metro, found) {
  if (!profileId) throw new Error('recordMetroRun needs a profileId');
  await db
    .prepare(
      `INSERT INTO source_cursor (profile_id, keyword, last_run_at, total_found, runs)
       VALUES (?,?,?,?,1)
       ON CONFLICT(profile_id, keyword) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         total_found = total_found + excluded.total_found,
         runs = runs + 1`
    )
    .bind(profileId, `osm:${metro}`, nowIso(), found)
    .run();
}
