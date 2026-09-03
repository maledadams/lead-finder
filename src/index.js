// Worker entry point: cron handlers + a small authenticated API + dashboard.

import { runCrawl } from './pipeline.js';
import { buildQueue, getQueue, markSent, markSkipped, suppress, todayStr } from './queue.js';
import { ingestSeeds } from './discover.js';
import { renderDashboard } from './dashboard.js';
import { harvestWikipedia, mineCorpus, storeCandidates, validateBatch } from './keywords.js';
import { queryCertTransparency } from './sources.js';

/**
 * Headers applied to every response.
 *
 * `Referrer-Policy: no-referrer` matters more than it looks here: the
 * dashboard can be opened with the key in the query string, and without this
 * that key would be sent to any site linked from a lead card.
 */
const SECURITY_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
    },
  });

/**
 * Content Security Policy for the dashboard.
 *
 * The page loads nothing from anywhere — no CDN, no fonts, no images — so
 * everything can be locked to 'none' except the one inline script, which is
 * allowed by nonce rather than by 'unsafe-inline'. Lead data is scraped from
 * other people's websites, so a hostile page title reaching the dashboard
 * must not be able to execute.
 */
function cspFor(nonce) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Everything here is behind a shared key. Set it once:
 *   wrangler secret put DASHBOARD_KEY
 */
function authorized(request, env) {
  const expected = env.DASHBOARD_KEY;
  if (!expected) return false;                       // fail closed, never open
  const url = new URL(request.url);
  const provided =
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('key') || '';
  return timingSafeEqual(provided, expected);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Caller identity for rate limiting: the real client IP Cloudflare saw. */
function clientKey(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

/**
 * Ask a limiter for permission. Missing binding means allow — a limiter that
 * is not configured must not take the whole Worker down.
 */
async function withinLimit(limiter, key) {
  if (!limiter?.limit) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success !== false;
  } catch {
    return true;
  }
}

const tooMany = (retryAfter = 60) =>
  new Response(JSON.stringify({ error: 'rate limited' }), {
    status: 429,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(retryAfter),
    },
  });

/**
 * Cloudflare Access, when the Worker is served from a custom domain behind a
 * Zero Trust policy.
 *
 * Access terminates the login and forwards a signed JWT. Its presence is
 * checked here so that turning Access on immediately tightens the Worker; the
 * signature itself is verified by Access at the edge before the request ever
 * reaches this code, and the request cannot reach a protected hostname
 * without one.
 *
 * On workers.dev there is no Access in front, so this returns false and the
 * shared key remains the only gate.
 */
function hasAccessAssertion(request) {
  return Boolean(request.headers.get('cf-access-jwt-assertion'));
}

export default {
  /**
   * Cron. This is the part that runs with the laptop off.
   *   0 6  * * *  -> crawl
   *   0 11 * * *  -> build the day's queue
   */
  async scheduled(event, env, ctx) {
    const db = env.DB;
    const isQueueRun = event.cron === '0 11 * * *';
    ctx.waitUntil(
      (isQueueRun ? buildQueue(env, db) : runCrawl(env, db)).catch((err) => {
        console.error('scheduled run failed', event.cron, err?.stack || err);
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DB;

    // Deliberately minimal and unauthenticated: liveness only, no version,
    // no account detail, nothing that helps someone map the deployment.
    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    const who = clientKey(request);

    // General throttle, applied before any work is done.
    if (!(await withinLimit(env.API_LIMITER, who))) return tooMany();

    if (!env.DASHBOARD_KEY) {
      return json({
        error: 'DASHBOARD_KEY is not set',
        fix: 'wrangler secret put DASHBOARD_KEY',
      }, 503);
    }

    // When REQUIRE_ACCESS is on, a request must arrive through Cloudflare
    // Access. Anything hitting the workers.dev hostname directly is refused,
    // which closes the bypass that would otherwise make Access decorative.
    if (env.REQUIRE_ACCESS === 'true' && !hasAccessAssertion(request)) {
      return json({ error: 'access required' }, 403);
    }

    if (!authorized(request, env)) {
      // One failure token per failure. This is the brute-force gate: eight
      // wrong keys a minute per IP, counted separately from ordinary traffic
      // so an attacker cannot hide inside it.
      if (!(await withinLimit(env.AUTH_LIMITER, `auth:${who}`))) return tooMany(120);
      return json({ error: 'unauthorized' }, 401);
    }

    try {
      // ---- dashboard ----------------------------------------------------
      if (url.pathname === '/' || url.pathname === '/dashboard') {
        const day = url.searchParams.get('day') || todayStr();
        const nonce = btoa(crypto.randomUUID()).replace(/=+$/, '');
        const html = await renderDashboard(db, env, day, nonce);
        return new Response(html, {
          headers: {
            ...SECURITY_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': cspFor(nonce),
          },
        });
      }

      // ---- read ---------------------------------------------------------
      if (url.pathname === '/api/queue' && request.method === 'GET') {
        return json(await getQueue(db, url.searchParams.get('day') || todayStr()));
      }

      if (url.pathname === '/api/entity' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'id required' }, 400);
        const entity = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first();
        if (!entity) return json({ error: 'not found' }, 404);
        const { results: snaps } = await db
          .prepare('SELECT fetched_at, http_status, content_hash, ttfb_ms FROM snapshots WHERE entity_id = ? ORDER BY fetched_at DESC LIMIT 10')
          .bind(id).all();
        const { results: keys } = await db
          .prepare('SELECT key, kind FROM entity_keys WHERE entity_id = ?').bind(id).all();
        return json({ entity, identity_keys: keys, snapshots: snaps });
      }

      if (url.pathname === '/api/stats' && request.method === 'GET') {
        const [states, budget, frontier, totals] = await Promise.all([
          db.prepare('SELECT state, COUNT(*) n FROM entities GROUP BY state').all(),
          db.prepare('SELECT metric, used FROM budget WHERE day = ?').bind(todayStr()).all(),
          db.prepare('SELECT status, COUNT(*) n FROM crawl_frontier GROUP BY status').all(),
          db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT domain) d FROM entities').first(),
        ]);
        return json({
          day: todayStr(),
          entities: totals?.n || 0,
          distinct_domains: totals?.d || 0,
          states: states.results,
          budget_used: budget.results,
          frontier: frontier.results,
        });
      }

      // ---- write --------------------------------------------------------
      if (url.pathname === '/api/seed' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const seeds = Array.isArray(body.seeds) ? body.seeds.slice(0, 500) : [];
        if (!seeds.length) return json({ error: 'seeds[] required' }, 400);
        return json(await ingestSeeds(db, seeds, body.source || 'manual-seed'));
      }

      const act = url.pathname.match(/^\/api\/outreach\/([\w-]+)\/(sent|skip|suppress)$/);
      if (act && request.method === 'POST') {
        const [, id, what] = act;
        if (what === 'sent') return json(await markSent(db, id));
        if (what === 'skip') return json(await markSkipped(db, id));

        const row = await db
          .prepare('SELECT e.contact_email, e.domain FROM outreach o JOIN entities e ON e.id = o.entity_id WHERE o.id = ?')
          .bind(id).first();
        if (!row) return json({ error: 'not-found' }, 404);
        await markSkipped(db, id, 'suppressed');
        return json(await suppress(db, row.contact_email || `domain:${row.domain}`, 'manual'));
      }

      // CAN-SPAM opt-out. Wire this to whatever receives your replies.
      if (url.pathname === '/api/suppress' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.key) return json({ error: 'key required (email or "domain:x.com")' }, 400);
        return json(await suppress(db, String(body.key).toLowerCase().trim(), body.reason || 'opt-out'));
      }

      // ---- manual triggers ----------------------------------------------
      if (url.pathname === '/api/run/crawl' && request.method === 'POST') {
        return json(await runCrawl(env, db));
      }
      if (url.pathname === '/api/keywords' && request.method === 'GET') {
        const { results } = await db.prepare(
          `SELECT keyword, niche, source, status, certs_seen, domains_kept, leads_found, runs
           FROM keywords ORDER BY
             CASE status WHEN 'ACTIVE' THEN 0 WHEN 'UNVALIDATED' THEN 1 ELSE 2 END,
             leads_found DESC, certs_seen DESC LIMIT 400`
        ).all();
        const counts = await db.prepare(
          'SELECT status, COUNT(*) n FROM keywords GROUP BY status'
        ).all();
        return json({ counts: counts.results, keywords: results });
      }

      if (url.pathname === '/api/run/harvest' && request.method === 'POST') {
        const h = await harvestWikipedia(db, env.USER_AGENT);
        const mined = await mineCorpus(db);
        const minedAdded = mined.length ? await storeCandidates(db, mined, 'corpus') : 0;
        return json({ wikipedia: h, corpus_terms_added: minedAdded });
      }

      if (url.pathname === '/api/run/validate' && request.method === 'POST') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 10), 40);
        const res = await validateBatch(db, limit, queryCertTransparency, env.USER_AGENT);
        return json(res);
      }

      if (url.pathname === '/api/run/queue' && request.method === 'POST') {
        const dryRun = url.searchParams.get('dry') === '1';
        return json(await buildQueue(env, db, { dryRun }));
      }

      return json({ error: 'not found', pathname: url.pathname }, 404);
    } catch (err) {
      console.error('request failed', url.pathname, err?.stack || err);
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};
