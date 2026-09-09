// Automated discovery sources. No human picks any brand.
//
// WHY THIS AND NOT A SCRAPER
//
// Crawlee (the open-source engine Apify runs on) is good software that does
// not fit here: it is a Node library needing a filesystem, long-running
// processes and a real Chromium binary, none of which the Workers runtime
// has, so it would need a machine that stays on. Its anti-blocking features
// — fingerprint spoofing, proxy and session rotation — are detection evasion,
// which is explicitly out of scope. And none of it produces a social login
// that will not get banned.
//
// The way around that is not a better scraper. It is to stop trying to get
// this data from platforms that forbid it, and take it from sources that
// exist to be queried:
//
//   1. CERTIFICATE TRANSPARENCY (crt.sh)
//      Every TLS certificate ever issued is published to public append-only
//      logs. That is the whole point of CT — it exists so anyone can audit
//      it. Querying it is free, needs no key, no browser, no login, and
//      violates nothing. A new certificate means a newly-launched domain, so
//      this surfaces businesses as they appear.
//
//   2. LINK-GRAPH EXPANSION (see discover.js)
//      Catches the brands CT cannot: the ones with abstract names like
//      "Moth & Moon" whose domain contains no niche keyword. They are found
//      because a brand we already know links to them.
//
// The two are complementary on purpose. CT seeds the graph automatically;
// the graph finds what keyword matching structurally misses.
//
// HONEST LIMITS
//   - crt.sh is a free community service. It rate-limits and times out. Every
//     failure here is treated as normal, never retried hard, never worked
//     around.
//   - Yield is noisy: "%ceramics%" returns industrial suppliers alongside
//     studio potters. That is fine and expected — the staged pipeline exists
//     precisely to throw away most candidates for almost no cost.

import { normalizeDomain, nowIso } from './entity.js';

const CRT_ENDPOINT = 'https://crt.sh/';
const CRT_TIMEOUT_MS = 25_000;

/**
 * The bootstrap terms, used only until a profile has its own.
 *
 * Deliberately thin and generic. A real search vocabulary is written per
 * profile — generated from the sentence describing who you want to reach, then
 * validated against how many real domains each term actually finds — because a
 * list tuned for one trade is worse than useless for another.
 */
export const SOURCE_KEYWORDS = {
  business: ['studio', 'workshop', 'atelier', 'boutique', 'collective'],
};

/** Flat list of every keyword, tagged with the niche it came from. */
export function allKeywords() {
  const out = [];
  for (const [niche, words] of Object.entries(SOURCE_KEYWORDS)) {
    for (const w of words) out.push({ niche, keyword: w });
  }
  return out;
}

/**
 * Pick the keywords least recently queried, so the rotation covers the whole
 * list over time instead of hammering the same few every day.
 */
export async function nextKeywords(db, profileId, limit) {
  if (!profileId) throw new Error('nextKeywords needs a profileId');
  const all = allKeywords();
  const { results } = await db
    .prepare('SELECT keyword, last_run_at FROM source_cursor WHERE profile_id = ?').bind(profileId)
    .all();
  const seen = new Map((results || []).map((r) => [r.keyword, r.last_run_at]));

  return all
    .sort((a, b) => (seen.get(a.keyword) || '').localeCompare(seen.get(b.keyword) || ''))
    .slice(0, limit);
}

export async function recordKeywordRun(db, profileId, keyword, found) {
  if (!profileId) throw new Error('recordKeywordRun needs a profileId');
  await db
    .prepare(
      `INSERT INTO source_cursor (profile_id, keyword, last_run_at, total_found, runs)
       VALUES (?,?,?,?,1)
       ON CONFLICT(profile_id, keyword) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         total_found = total_found + excluded.total_found,
         runs = runs + 1`
    )
    .bind(profileId, keyword, nowIso(), found)
    .run();
}

/**
 * Query Certificate Transparency for apex domains containing a keyword.
 *
 * Returns [] on any failure. A free community service being slow is normal
 * operation, not an error worth retrying aggressively.
 */
export async function queryCertTransparency(keyword, userAgent) {
  const url = `${CRT_ENDPOINT}?q=${encodeURIComponent(`%${keyword}%`)}&output=json`;

  let payload;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent || 'LeadFinderBot/0.1', Accept: 'application/json' },
      signal: AbortSignal.timeout(CRT_TIMEOUT_MS),
    });
    if (!res.ok) return { domains: [], error: `http-${res.status}` };
    payload = await res.json();
  } catch (err) {
    return { domains: [], error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 120) };
  }

  if (!Array.isArray(payload)) return { domains: [], error: 'unexpected-shape' };
  return { domains: extractApexDomains(payload, keyword), certs: payload.length, error: null };
}

/**
 * Pull usable apex domains out of a crt.sh response.
 *
 * Filters aggressively here rather than downstream, because every domain that
 * survives costs a real HTTP fetch later.
 */
export function extractApexDomains(certs, keyword) {
  const out = new Set();

  for (const cert of certs) {
    const names = String(cert?.name_value || '').split('\n');
    for (const raw of names) {
      const name = raw.trim().toLowerCase();
      if (!name || name.includes('*') || name.includes(' ')) continue;

      // Apex domains only — no subdomains. A brand's cert usually covers both
      // "brand.com" and "www.brand.com"; the subdomain forms are noise.
      const labels = name.split('.');
      if (labels.length !== 2) continue;
      if (!labels[0].includes(keyword.slice(0, 6))) {
        // The keyword must be in the name itself, not only in a sibling SAN.
        if (!name.includes(keyword.slice(0, 6))) continue;
      }

      const domain = normalizeDomain(name);
      if (!domain) continue;
      if (!isPlausibleBrandDomain(domain)) continue;
      out.add(domain);
    }
  }
  return [...out];
}

// TLDs a US creative brand plausibly uses. Everything else is dropped rather
// than fetched, because geography is a hard constraint and a fetch is not free.
const ALLOWED_TLDS = new Set([
  'com', 'co', 'shop', 'studio', 'store', 'art', 'design', 'us', 'net', 'club', 'boutique',
]);

// Words that mark an industrial supplier, a franchise, or a corporate entity
// rather than a founder-led brand. Substring matching, not word-boundary:
// "saudiceramics" and "landmarkceramics" have no separators to anchor on.
const NOT_A_BRAND = new RegExp([
  // industrial / building trade — the dominant false positive for craft terms
  'tile', 'sanitary', 'refractor', 'abrasive', 'insulation', 'porcelainware',
  'bearing', 'granite', 'marble', 'flooring', 'plumbing', 'hvac', 'roofing',
  'concrete', 'masonry', 'kitchenbath', 'countertop',
  // corporate structure
  'industrial', 'technical', 'advanced', 'solutions', 'systems', 'engineering',
  'supplies', 'equipment', 'corporation', 'holdings', 'international',
  'globalgroup', 'manufacturing', 'distributor', 'wholesaleinc',
  // clearly other sectors
  'hospital', 'clinic', 'dental', 'insurance', 'realty', 'mortgage',
  'lawfirm', 'attorney', 'bankof', 'university', 'college',
].join('|'), 'i');

// Country words that appear in the domain itself. Geography is a hard
// constraint, so paying for a fetch to discover a brand is Saudi or Indian is
// waste we can avoid for free.
const NON_US_MARKER = /(?:saudi|emirates|dubai|qatar|kuwait|india|indian|pakistan|bangla|nigeria|kenya|malaysia|indonesia|vietnam|thai|philippine|brasil|brazil|mexico|espana|deutschland|france|italia|nippon|korea|shanghai|beijing|guangzhou|shenzhen|australia|canada|newzealand)/i;

export function isPlausibleBrandDomain(domain) {
  const [name, ...rest] = domain.split('.');
  const tld = rest[rest.length - 1];
  if (!ALLOWED_TLDS.has(tld)) return false;
  if (name.length < 5 || name.length > 40) return false;
  if (/^\d/.test(name)) return false;
  if (/\d{3,}/.test(name)) return false;               // hashes, dev stores
  if (NOT_A_BRAND.test(domain)) return false;
  if (NON_US_MARKER.test(domain)) return false;
  return true;
}
