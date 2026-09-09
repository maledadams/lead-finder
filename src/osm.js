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
import { DEFAULT_NICHE } from './config.js';

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
 * The OpenStreetMap search a profile performs, derived from its own niches.
 *
 * NOTHING HERE IS BUILT IN. Which tags belong to which category, which names to
 * exclude, and whether a business with no website still counts — all three are
 * per profile, because none of them generalise. A hand-tuned list of craft tags
 * that finds independent makers is exactly the wrong list for finding dental
 * clinics, and the rule that a no-website lead needs an Instagram would throw
 * away every plumber worth writing to.
 *
 * A profile that defines no tags simply discovers by keyword instead, which is
 * what a brand-new install does until it is set up.
 *
 * `social` is the real difference between two populations. For a boutique with
 * no website an Instagram IS the signal — it says the owner is brand-conscious
 * and has nowhere to send people. For a clinic it is noise: a phone number and
 * no website is the lead. So the fallback contact tag is a profile's choice.
 */
export function osmSpecFor(profile) {
  const niches = profile?.niches || {};
  const fields = ['amenity', 'healthcare', 'craft', 'shop', 'office'];
  const tags = Object.fromEntries(fields.map((f) => [f, []]));
  const byNiche = {};
  let configured = false;

  for (const [slug, n] of Object.entries(niches)) {
    if (!n?.osm) continue;
    configured = true;
    byNiche[slug] = {};
    for (const f of fields) {
      const values = (Array.isArray(n.osm[f]) ? n.osm[f] : []).map(String);
      byNiche[slug][f] = values;
      tags[f].push(...values);
    }
  }
  for (const f of fields) tags[f] = [...new Set(tags[f])];

  // A profile's own exclusions, compiled once. Invalid patterns are ignored
  // rather than thrown: a bad regex typed into Settings must not stop a crawl.
  let nameFilter = null;
  const pattern = profile?.discovery?.exclude_names;
  if (pattern) {
    try { nameFilter = new RegExp(pattern, 'i'); } catch { nameFilter = null; }
  }

  return {
    tags,
    byNiche: configured ? byNiche : null,
    social: profile?.discovery?.social === true,
    nameFilter,
    fallbackNiche: Object.keys(niches)[0] || DEFAULT_NICHE,
  };
}

/** Map an OSM category onto a profile's niche taxonomy. */
export function nicheForTags(tags, spec = osmSpecFor(null)) {
  // A lead can only ever land in a category this profile actually writes for.
  if (spec.byNiche) {
    for (const [slug, fields] of Object.entries(spec.byNiche)) {
      for (const [field, values] of Object.entries(fields)) {
        if (tags[field] && values.includes(tags[field])) return slug;
      }
    }
  }
  return spec.fallbackNiche;
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
