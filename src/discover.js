// Discovery.
//
// Honest position, stated once so it is not lost: automated discovery from
// Instagram, TikTok and Etsy is NOT achievable under the project's
// constraints. Those platforms are JS-rendered and login-walled, their terms
// forbid automated collection, and Workers has no browser. Anything claiming
// otherwise is either paying for a scraping service, running a browser on a
// machine that must stay on, or violating terms.
//
// What IS achievable, legitimately and with the laptop off:
//
//   1. SEEDS — you paste in brands you already like. Two minutes, done in
//      batches whenever you feel like it. This is the only manual step.
//
//   2. LINK-GRAPH EXPANSION — the real engine. Independent brands link to
//      independent brands: stockist lists, "brands we love", collaborators,
//      press pages, market line-ups. Following that graph propagates taste,
//      because a brand you like tends to link to brands you would also like.
//      It is public HTML, it respects robots.txt, and it runs in a Worker.
//
//   3. RE-EVALUATION — as the pool grows, a rising share of each day's queue
//      comes from businesses already known whose signals changed. That is a
//      genuine discovery source and it compounds.

import { CRAWL_SKIP_HOSTS, MARKETPLACE_HOSTS, PEER_LINK_HINTS } from './config.js';
import { normalizeDomain, normalizeUrl, nowIso, resolveEntity } from './entity.js';

/**
 * Take a batch of raw seeds and turn them into entities + frontier rows.
 *
 * A seed can be a bare domain, a full URL, an Instagram/TikTok/Etsy link, or
 * an object with several of those. Anything unparseable is reported back
 * rather than silently dropped.
 */
export async function ingestSeeds(db, profileId, seeds, source = 'seed') {
  const out = { accepted: 0, duplicates: 0, rejected: [], entities: [] };

  for (const raw of seeds) {
    const seed = typeof raw === 'string' ? parseSeedString(raw) : raw;
    if (!seed) { out.rejected.push(String(raw).slice(0, 120)); continue; }

    seed.discovery_source = seed.discovery_source || source;
    const res = await resolveEntity(db, seed);
    if (!res.id) { out.rejected.push(String(raw).slice(0, 120)); continue; }

    if (res.created) out.accepted++;
    else out.duplicates++;
    out.entities.push({ id: res.id, created: res.created, merged: res.merged });

    const url = seed.website ? normalizeUrl(seed.website) : null;
    if (url) await addToFrontier(db, [{ url, depth: 0, priority: 100, reason: source }], res.id);
  }

  return out;
}

/** Work out what kind of identifier a pasted line is. */
export function parseSeedString(line) {
  const s = String(line).trim();
  if (!s || s.startsWith('#')) return null;

  if (/instagram\.com/i.test(s)) return { instagram: s };
  if (/tiktok\.com/i.test(s)) return { tiktok: s };
  if (/etsy\.com/i.test(s)) return { etsy: s };
  if (s.startsWith('@')) return { instagram: s };

  const url = normalizeUrl(s);
  const domain = normalizeDomain(s);
  if (url && domain && !MARKETPLACE_HOSTS.has(domain)) {
    return { website: url, domain, display_name: domain.split('.')[0] };
  }
  return null;
}

/**
 * Add candidate URLs to the crawl frontier, one per domain, skipping anything
 * we already know about.
 */
export async function addToFrontier(db, profileId, candidates, parentEntityId = null) {
  if (!candidates.length) return 0;

  const byDomain = new Map();
  for (const c of candidates) {
    const domain = normalizeDomain(c.url);
    if (!domain) continue;
    if (CRAWL_SKIP_HOSTS.has(domain) || MARKETPLACE_HOSTS.has(domain)) continue;
    if (!byDomain.has(domain) || (byDomain.get(domain).priority || 0) < (c.priority || 0)) {
      byDomain.set(domain, { ...c, domain });
    }
  }
  if (!byDomain.size) return 0;

  const domains = [...byDomain.keys()];
  const ph = domains.map(() => '?').join(',');

  // Skip a domain only if it is already queued, or belongs to a business we
  // have actually crawled before. Merely *knowing* a business is not a reason
  // to skip it — a freshly seeded entity has never been fetched, and that is
  // exactly what the frontier is for.
  const [crawled, queued] = await Promise.all([
    db.prepare(
      `SELECT domain FROM entities
       WHERE domain IN (${ph}) AND last_evaluated_at IS NOT NULL`
    ).bind(...domains).all(),
    db.prepare(`SELECT domain FROM crawl_frontier WHERE profile_id = ? AND domain IN (${ph})`).bind(profileId, ...domains).all(),
  ]);

  const skip = new Set([
    ...(crawled.results || []).map((r) => r.domain),
    ...(queued.results || []).map((r) => r.domain),
  ]);

  const fresh = domains.filter((d) => !skip.has(d)).map((d) => byDomain.get(d));
  if (!fresh.length) return 0;

  const ts = nowIso();
  await db.batch(
    fresh.map((c) =>
      db.prepare(
        `INSERT OR IGNORE INTO crawl_frontier
           (profile_id, url, domain, depth, parent_entity, reason, priority, status, added_at)
         VALUES (?,?,?,?,?,?,?, 'PENDING', ?)`
      ).bind(
        profileId, normalizeUrl(c.url), c.domain, c.depth || 0,
        parentEntityId, (c.reason || 'link').slice(0, 120), c.priority || 0, ts
      )
    )
  );
  return fresh.length;
}

/**
 * Choose which outbound links from a crawled page are worth following.
 *
 * The scoring here is what keeps the crawl on-taste instead of wandering into
 * payment processors and font CDNs.
 */
export function selectPeerLinks(signals, sourceUrl, depth) {
  const sourceDomain = normalizeDomain(sourceUrl);
  const seen = new Map();

  for (const link of signals.links || []) {
    const domain = normalizeDomain(link.url);
    if (!domain || domain === sourceDomain) continue;
    if (CRAWL_SKIP_HOSTS.has(domain) || MARKETPLACE_HOSTS.has(domain)) continue;
    // Skip obvious infrastructure subdomains and file links.
    if (/\.(pdf|zip|jpe?g|png|gif|svg|mp4|css|js)(\?|$)/i.test(link.url)) continue;
    if (/^(cdn|assets|static|img|media|api|mail|track)\./i.test(domain)) continue;

    const label = (link.label || '').toLowerCase();
    let priority = 10;

    // Anchor text that reads like a peer-brand reference.
    for (const hint of PEER_LINK_HINTS) {
      if (label.includes(hint)) { priority += 30; break; }
    }
    // A bare homepage link is far more likely to be a brand than a deep link.
    try {
      const p = new URL(link.url).pathname.replace(/\/+$/, '');
      if (p === '' || p === '/') priority += 25;
      else if (p.split('/').filter(Boolean).length <= 1) priority += 10;
      else priority -= 10;
    } catch { /* ignore */ }

    // Anchor text that looks like a brand name, not navigation.
    if (label && label.length <= 40 && !/\b(home|shop|about|contact|privacy|terms|faq|cart|login|search|blog)\b/.test(label)) {
      priority += 8;
    }

    if (priority < 20) continue;
    const prev = seen.get(domain);
    if (!prev || prev.priority < priority) {
      seen.set(domain, {
        url: `https://${domain}`,
        priority,
        depth: depth + 1,
        reason: label ? `link:"${label.slice(0, 60)}"` : 'link',
      });
    }
  }

  return [...seen.values()].sort((a, b) => b.priority - a.priority).slice(0, 25);
}

/** Pull the next batch of pending frontier URLs, highest priority first. */
export async function takeFrontierBatch(db, profileId, limit) {
  const { results } = await db
    .prepare(
      `SELECT url, domain, depth, parent_entity, reason FROM crawl_frontier
       WHERE profile_id = ? AND status = 'PENDING'
       ORDER BY priority DESC, added_at ASC
       LIMIT ?`
    )
    .bind(profileId, limit)
    .all();
  return results || [];
}

export async function markFrontier(db, profileId, url, status) {
  await db
    .prepare('UPDATE crawl_frontier SET status = ?, processed_at = ? WHERE profile_id = ? AND url = ?')
    .bind(status, nowIso(), profileId, url)
    .run();
}

/**
 * Entities due another look. Two reasons to re-check: enough time has passed,
 * or the score sat just under the bar and might have moved.
 */
export async function staleEntities(db, profileId, { days, nearMissFrom, nearMissTo, limit }) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, website, domain, display_name, instagram, phone, osm_tags,
              has_website, niche, contact_email, score, state, last_evaluated_at
       FROM entities
       WHERE profile_id = ?
         AND (website IS NOT NULL OR has_website = 0)
         AND state NOT IN ('CONTACTED','REPLIED','CONVERSATION','CLIENT','DO_NOT_CONTACT','REJECTED')
         AND (
              last_evaluated_at IS NULL
           OR last_evaluated_at < ?
           OR (score BETWEEN ? AND ? AND last_evaluated_at < ?)
         )
       ORDER BY COALESCE(last_evaluated_at, '') ASC
       LIMIT ?`
    )
    .bind(
      profileId,
        cutoff,
      nearMissFrom,
      nearMissTo,
      new Date(Date.now() - Math.floor(days / 3) * 86400_000).toISOString(),
      limit
    )
    .all();
  return results || [];
}
