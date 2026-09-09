// Where the discovery vocabulary comes from.
//
// Hand-writing keywords does not work, and the first attempt proved it: terms
// I invented — "wheelthrown", "cutecore", "handpoured", "gyaru" — return zero
// certificates, while plain roots like "lolita" (2983), "emo" (491), "kawaii"
// (90), "harajuku" (68) and "decora" (64) are productive. Guessing produces
// a list that looks right and finds nothing.
//
// So the list is harvested and then measured:
//
//   1. HARVEST   Wikipedia enumerates fashion subcultures and aesthetics in
//                exactly the categories a profile cares about. Free, keyless, and
//                the API is meant to be queried.
//   2. MINE      Terms that actually appear on businesses we already scored
//                well. This is the self-improving half — the corpus teaches
//                the crawler what its own good leads look like.
//   3. VALIDATE  Every candidate is tested against real crt.sh yield before
//                it is ever used, and recorded. A term that returns nothing
//                is marked DEAD and never queried again.
//   4. PRUNE     Terms that return certificates but never survive filtering
//                fall out on their own via `domains_kept` / `leads_found`.

import { nowIso } from './entity.js';
import { isPlausibleBrandDomain } from './sources.js';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_TIMEOUT_MS = 20_000;

/**
 * Wikipedia pages to mine vocabulary from — a profile's own, not the code's.
 *
 * Which list pages are worth reading depends entirely on what you are looking
 * for; "Japanese street fashion" builds a good vocabulary for one operation and
 * none at all for another. So the shipped list is empty, and a profile supplies
 * its own in discovery.wiki_sources. With none, harvesting is skipped and
 * discovery runs on the profile's search terms alone.
 */
export const WIKI_SOURCES = [];

/** This profile's sources, falling back to none rather than to someone else's. */
export function wikiSourcesFor(profile) {
  const own = profile?.discovery?.wiki_sources;
  return Array.isArray(own) && own.length ? own : WIKI_SOURCES;
}

/**
 * Terms that are about fashion but useless as domain keywords: events,
 * histories, geographies, academic articles, and anything too generic to
 * distinguish a brand.
 */
const WIKI_NOISE = new RegExp([
  // meta-articles and events
  'fashion week', 'history of', 'list of', 'timeline', 'glossary', 'outline of',
  'index of', 'category:', 'template:', 'portal:', 'wikipedia:',
  '\\d{4}', '\\d{2}(?:st|th|nd|rd) century', 'week in',
  // institutions and press
  'college', 'university', 'museum', 'magazine', 'award', 'academy',
  'institute', 'company', 'industry', 'retail', 'publish', 'press\\b',
  'journal', 'encyclop', 'routledge', 'tauris', 'berg\\b',
  // cultural-studies vocabulary that flooded the first harvest
  'cultur', 'sociolog', 'anthropolog', 'semiotic', 'theory',
  'studies', 'identity', 'consumer', 'globali', 'postmodern', 'discourse',
  // geography and nationality, which never make good brand keywords
  // "Fashion in South Korea", "Dress in the United States" - allow qualifiers
  // between "in" and the place name.
  'in\\s+(?:the\\s+)?(?:[a-z]+\\s+)?(?:japan|korea|china|india|france|italy|germany|spain|brazil|states|kingdom)',
  'italian', 'korean', 'chinese', 'french', 'russian', 'american fashion',
  'ancient', 'medieval', 'victorian era', 'western fashion',
].join('|'), 'i');

/**
 * Named people, listed rather than pattern-matched.
 *
 * A "two capitalised words" heuristic was tried and removed: it rejected
 * "Gothic Lolita", "Sweet Lolita" and "Visual Kei" — core vocabulary — because
 * style names have exactly the same shape as personal names. Since the
 * citation-heavy `links` sources were dropped, person names are rare enough
 * that an explicit list plus validation handles what is left.
 */
const KNOWN_PEOPLE = /^(?:vivienne westwood|lewis carroll|sumire uesaka|sonia leong|andrew bolton|paul morley|garry crawford|roger k\.? burton|malcolm mclaren|alexander mcqueen)$/i;

/**
 * Ordinary English words that happen to be fashion terms.
 *
 * Validation alone does not catch these: "camp" returns 4548 certificates and
 * 81 plausible domains, all of them campgrounds, summer camps and RV dealers.
 * A term has to be *distinctive*, not merely productive, so common words are
 * rejected before they ever reach validation.
 */
const AMBIGUOUS_COMMON = new Set([
  'camp', 'boyfriend', 'girlfriend', 'cutoff', 'cut', 'crop', 'wrap', 'shift',
  'slip', 'shell', 'tank', 'boot', 'boots', 'jumper', 'romper', 'tie', 'bow',
  'cape', 'coat', 'suit', 'sock', 'socks', 'hat', 'cap', 'bag', 'belt', 'ring',
  'chain', 'plain', 'sharp', 'smart', 'casual', 'formal', 'classic', 'modern',
  'vintage', 'retro', 'basic', 'simple', 'natural', 'organic', 'clean',
  'sulu', 'geek', 'nerd', 'mod', 'ska', 'emo',
  // Style adjectives. "chic" passed validation with 1,267 certificates and 57
  // plausible domains — chic salons, chic nails, chic realty. Same failure as
  // "camp": productive, but it identifies nothing.
  'chic', 'glam', 'boho', 'preppy', 'grunge', 'edgy', 'luxe', 'posh',
  'trendy', 'stylish', 'elegant', 'urban', 'street', 'wild', 'pure',
]);

const TOO_GENERIC = new Set([
  'fashion', 'clothing', 'style', 'dress', 'subculture', 'lifestyle', 'culture',
  'aesthetic', 'aesthetics', 'design', 'art', 'artist', 'craft', 'handicraft',
  'beauty', 'cosmetics', 'makeup', 'apparel', 'textile', 'model', 'modelling',
  'androgyny', 'pottery', 'ceramics', 'jewellery', 'jewelry',
]);

/**
 * Turn a Wikipedia article title into a domain-shaped keyword.
 *
 * "Gothic Lolita" -> "gothiclolita"; "Visual Kei" -> "visualkei";
 * "Aristocrat (fashion)" -> "aristocrat".
 *
 * Returns null when the title is noise or the result is unusable.
 */
export function titleToKeyword(title) {
  if (!title || WIKI_NOISE.test(title)) return null;
  if (KNOWN_PEOPLE.test(String(title).trim())) return null;

  // Drop disambiguators: "Aristocrat (fashion)" -> "Aristocrat".
  const base = String(title).replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!base || base.includes(':')) return null;                 // namespaced pages

  const token = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (token.length < 3 || token.length > 22) return null;
  if (TOO_GENERIC.has(token)) return null;
  if (AMBIGUOUS_COMMON.has(token)) return null;
  if (/^\d/.test(token)) return null;

  return token;
}

/** Fetch one Wikipedia source. Returns [] on any failure. */
export async function harvestOne(source, userAgent) {
  const params = source.kind === 'category'
    ? new URLSearchParams({
        action: 'query', list: 'categorymembers',
        cmtitle: `Category:${source.title}`, cmlimit: '200',
        format: 'json', formatversion: '2',
      })
    : new URLSearchParams({
        action: 'parse', page: source.title, prop: 'links',
        format: 'json', formatversion: '2',
      });

  let payload;
  try {
    const res = await fetch(`${WIKI_API}?${params}`, {
      headers: { 'User-Agent': userAgent || 'LeadFinderBot/0.1' },
      signal: AbortSignal.timeout(WIKI_TIMEOUT_MS),
    });
    if (!res.ok) return { terms: [], error: `http-${res.status}` };
    payload = await res.json();
  } catch (err) {
    return { terms: [], error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 100) };
  }

  const titles = source.kind === 'category'
    ? (payload?.query?.categorymembers || []).map((m) => m.title)
    : (payload?.parse?.links || []).filter((l) => l.ns === 0).map((l) => l.title);

  const terms = [];
  const seen = new Set();
  for (const t of titles) {
    const kw = titleToKeyword(t);
    if (kw && !seen.has(kw)) { seen.add(kw); terms.push({ keyword: kw, niche: source.niche, title: t }); }
  }
  return { terms, error: null };
}

/**
 * Mine distinctive terms from businesses that already scored well.
 *
 * The self-improving half: whatever vocabulary the good leads share becomes
 * vocabulary to search for. Deliberately compares against the *low* scorers
 * so common retail words do not survive.
 */
export async function mineCorpus(db, profileId, { minScore = 60, limit = 300 } = {}) {
  if (!profileId) throw new Error('mineCorpus needs a profileId');
  const [good, bad] = await Promise.all([
    db.prepare(
      `SELECT s.text_sample FROM entities e JOIN snapshots s ON s.entity_id = e.id
       WHERE e.profile_id = ? AND e.score >= ? AND s.text_sample IS NOT NULL LIMIT ?`
    ).bind(profileId, minScore, limit).all(),
    db.prepare(
      `SELECT s.text_sample FROM entities e JOIN snapshots s ON s.entity_id = e.id
       WHERE e.profile_id = ? AND e.score < ? AND s.text_sample IS NOT NULL LIMIT ?`
    ).bind(profileId, minScore, limit).all(),
  ]);

  const goodRows = good.results || [];
  if (goodRows.length < 5) return [];          // not enough signal yet

  const countGood = tally(goodRows);
  const countBad = tally(bad.results || []);
  const nGood = goodRows.length;
  const nBad = (bad.results || []).length || 1;

  const scored = [];
  for (const [term, g] of countGood) {
    if (g < 3) continue;                        // must recur
    const gRate = g / nGood;
    const bRate = (countBad.get(term) || 0) / nBad;
    if (gRate < 0.05) continue;
    // Distinctive: appears far more in good pages than in bad ones.
    const lift = gRate / (bRate + 0.01);
    if (lift < 2.5) continue;
    scored.push({ keyword: term, lift, gRate });
  }

  return scored.sort((a, b) => b.lift - a.lift).slice(0, 40)
    .map((s) => ({ keyword: s.keyword, niche: null }));
}

const STOPWORDS = new Set(`the and for you our with your from that this all are was
were has have will can not but they she her his out now new get see how why who what
when where about more most some any each other than then them our ours shop store
home page cart checkout menu search sign login account order orders shipping returns
policy privacy terms contact email address phone hours open closed sale off free
products product collection collections view add price prices usd size sizes color
colors black white blue green small large one two three click here read`.split(/\s+/));

function tally(rows) {
  const counts = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const w of String(r.text_sample || '').toLowerCase().match(/[a-z]{4,18}/g) || []) {
      if (STOPWORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return counts;
}

/** Insert candidates as UNVALIDATED. Existing rows are left alone. */
export async function storeCandidates(db, profileId, candidates, source) {
  if (!profileId) throw new Error('storeCandidates needs a profileId');
  if (!candidates.length) return 0;
  const ts = nowIso();
  let added = 0;

  for (let i = 0; i < candidates.length; i += 40) {
    const chunk = candidates.slice(i, i + 40);
    const res = await db.batch(
      chunk.map((c) =>
        db.prepare(
          `INSERT OR IGNORE INTO keywords (profile_id, keyword, niche, source, status, added_at)
           VALUES (?,?,?,?, 'UNVALIDATED', ?)`
        ).bind(profileId, c.keyword, c.niche || null, source, ts)
      )
    );
    added += res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
  }
  return added;
}

// When crt.sh is down we record it and stay away for a while.
const SOURCE_HEALTH_KEY = '__crtsh_backoff';
const BACKOFF_MINUTES = 90;

async function sourceInBackoff(db) {
  const row = await db
    .prepare('SELECT last_run_at FROM source_cursor WHERE profile_id = ? AND keyword = ?')
    .bind(SOURCE_HEALTH_KEY)
    .first();
  if (!row?.last_run_at) return false;
  return Date.now() - Date.parse(row.last_run_at) < BACKOFF_MINUTES * 60_000;
}

async function markSourceDown(db) {
  await db
    .prepare(
      `INSERT INTO source_cursor (profile_id, keyword, last_run_at, total_found, runs)
       VALUES (?,?,?,0,1)
       ON CONFLICT(profile_id, keyword) DO UPDATE SET
         last_run_at = excluded.last_run_at, runs = runs + 1`
    )
    .bind(profileId, SOURCE_HEALTH_KEY, nowIso())
    .run();
}

/**
 * Test unvalidated keywords against real crt.sh yield and mark them
 * ACTIVE or DEAD. This is what stops the list filling with plausible-sounding
 * terms that find nothing.
 */
export async function validateBatch(db, profileId, limit, queryFn, userAgent, concurrency = 3) {
  if (!profileId) throw new Error('validateBatch needs a profileId');
  // Back off entirely while the source is known to be down.
  //
  // The circuit breaker alone was not enough: it stops a batch after six
  // failures, but every subsequent call started another six. Ten consecutive
  // attempts burned sixty pointless requests against a service that was
  // already returning 502 to everything. Now the first failing batch parks the
  // source and nothing touches it again for an hour and a half.
  if (await sourceInBackoff(db)) {
    return { tested: 0, active: 0, dead: 0, failed: 0, skipped: 'source-backoff' };
  }

  const { results } = await db
    .prepare("SELECT keyword FROM keywords WHERE profile_id = ? AND status = 'UNVALIDATED' ORDER BY added_at LIMIT ?")
    .bind(limit)
    .all();

  const rows = results || [];
  const out = { tested: 0, active: 0, dead: 0, failed: 0 };
  const updates = [];

  // Validated in small parallel waves rather than one at a time.
  //
  // Each crt.sh call can take up to 25 seconds, so sequential validation moved
  // at roughly eleven keywords per attempt against a backlog of a thousand —
  // it would never have caught up. Concurrency stays low because crt.sh is a
  // free community service and hammering it is both rude and self-defeating.
  let consecutiveFailures = 0;

  for (let i = 0; i < rows.length; i += concurrency) {
    // Circuit breaker.
    //
    // crt.sh is a free community service and it does go down — during
    // development it began returning 502 to everything, partly because this
    // code had been hammering it. When a whole wave fails there is no point
    // sending another: stop, leave the rest unvalidated, and try on a later
    // run. Keywords are never condemned by an outage.
    if (consecutiveFailures >= concurrency * 2) {
      out.stopped = 'source-unavailable';
      await markSourceDown(db);
      break;
    }

    const wave = rows.slice(i, i + concurrency);
    const settled = await Promise.all(
      wave.map(async (row) => ({ row, res: await queryFn(row.keyword, userAgent) }))
    );

    for (const { row, res } of settled) {
      out.tested++;
      // A transient failure must not condemn a keyword — it stays
      // unvalidated and is retried on a later run.
      if (res.error) { out.failed++; consecutiveFailures++; continue; }
      consecutiveFailures = 0;

      const kept = (res.domains || []).filter(isPlausibleBrandDomain).length;
      const status = (res.domains || []).length === 0 ? 'DEAD' : 'ACTIVE';
      if (status === 'ACTIVE') out.active++; else out.dead++;

      updates.push(
        db.prepare(
          `UPDATE keywords SET status = ?, certs_seen = ?, domains_kept = ?, last_run_at = ?
           WHERE profile_id = ? AND keyword = ?`
        ).bind(status, res.certs ?? (res.domains || []).length, kept, nowIso(), profileId, row.keyword)
      );
    }
  }

  // One batched write rather than one per keyword.
  for (let i = 0; i < updates.length; i += 40) {
    await db.batch(updates.slice(i, i + 40));
  }
  return out;
}

/**
 * Retire keywords that keep returning domains but never yield a lead.
 *
 * The last line of defence against terms that pass validation on volume alone.
 * Only applies once a keyword has had a fair number of runs.
 */
export async function demoteUnproductive(db, profileId, { minRuns = 6 } = {}) {
  if (!profileId) throw new Error('demoteUnproductive needs a profileId');
  const res = await db
    .prepare(
      `UPDATE keywords SET status = 'DEAD'
       WHERE profile_id = ? AND status = 'ACTIVE' AND runs >= ? AND leads_found = 0`
    )
    .bind(profileId, minRuns)
    .run();
  return { demoted: res.meta?.changes || 0 };
}

/** Active keywords, least recently used first. */
export async function activeKeywords(db, profileId, limit) {
  if (!profileId) throw new Error('activeKeywords needs a profileId');
  const { results } = await db
    .prepare(
      `SELECT keyword, niche FROM keywords
       WHERE profile_id = ? AND status = 'ACTIVE'
       ORDER BY COALESCE(last_run_at, '') ASC, domains_kept DESC
       LIMIT ?`
    )
    .bind(profileId, limit)
    .all();
  return results || [];
}

export async function recordUse(db, profileId, keyword, leadsFound) {
  if (!profileId) throw new Error('recordUse needs a profileId');
  await db
    .prepare(
      `UPDATE keywords
       SET last_run_at = ?, runs = runs + 1, leads_found = leads_found + ?
       WHERE profile_id = ? AND keyword = ?`
    )
    .bind(nowIso(), leadsFound, profileId, keyword)
    .run();
}

/** Harvest every configured Wikipedia source. */
export async function harvestWikipedia(db, profileId, userAgent, profile = null) {
  if (!profileId) throw new Error('harvestWikipedia needs a profileId');
  const out = { sources: 0, terms: 0, added: 0, errors: [] };

  for (const source of wikiSourcesFor(profile)) {
    const { terms, error } = await harvestOne(source, userAgent);
    out.sources++;
    if (error) { out.errors.push(`${source.title}: ${error}`); continue; }
    out.terms += terms.length;
    out.added += await storeCandidates(db, profileId, terms, `wikipedia:${source.title}`);
  }
  return out;
}
