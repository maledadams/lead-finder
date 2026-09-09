// Worker entry point: cron handlers + a small authenticated API + dashboard.

import { runCrawl } from './pipeline.js';
import {
  buildQueue, getQueue, markBounced, markSent, markSkipped, revive, RESPONSE_STATUSES,
  setResponseStatus, suppress, sweepGhosted, todayStr,
} from './queue.js';
import { ingestSeeds } from './discover.js';
import { renderDashboard } from './dashboard.js';
import { PERIODS } from './metrics.js';
import { canReceiveMail } from './mx.js';
import { syncBounces } from './bounces.js';
import { applyCorrection } from './correct.js';
import {
  canSpamFooter, hasCanSpamFooter, stripControl, stripControlKeepLines,
} from './outreach.js';
import { harvestWikipedia, mineCorpus, storeCandidates, validateBatch } from './keywords.js';
import { queryCertTransparency } from './sources.js';
import { deriveLessons, recordFeedback, rerankOne } from './learning.js';
import {
  createProfile, listProfiles, resolveProfile, setDefaultProfile,
} from './profiles.js';
import { calConfigured, upcomingBookings } from './cal.js';
import {
  completeLogin, exchangeKeyForSession, googleConfigured, logout,
  sessionFrom, startLogin, verifySession,
} from './auth.js';
import {
  authorizeUrl, exchangeCode, fetchSignature, sendMail, sentToday, signState,
  verifyState, zohoConfigured, zohoConnected,
} from './zoho.js';

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
    // The tab icon is an inline SVG data URI. `data:` only — no host is
    // allowed, so this cannot become a way to load a remote image.
    "img-src data:",
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

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** The rendered pages. Every one gets a nonce and cspFor(). */
const PAGES = {
  '/': 'today',
  '/dashboard': 'today',
  '/sent': 'sent',
  '/skipped': 'skipped',
  '/bounced': 'bounced',
  '/metrics': 'metrics',
  '/calendar': 'calendar',
};

/** The profile a browser last switched to, remembered so API calls agree. */
const PROFILE_COOKIE = 'lf_profile';

function cookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  const hit = raw.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

/** A date filter is only ever YYYY-MM-DD. Anything else is not a date. */
function dateParam(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;
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

/**
 * The email of whoever Cloudflare Access authenticated, or null.
 *
 * Trusting these headers is safe here for one specific reason: the only route
 * to this Worker is leads.maledadams.work, which sits behind Access, and
 * workers.dev is disabled. A request cannot reach this code without Access
 * having verified it first, so the headers cannot be forged by a client.
 *
 * If another route is ever added, this assumption breaks and the JWT would
 * need verifying against the team's public keys.
 */
function accessUser(request) {
  if (!hasAccessAssertion(request)) return null;
  return request.headers.get('cf-access-authenticated-user-email') || 'access-user';
}

export default {
  /**
   * Cron. This is the part that runs with the laptop off.
   *   0 6  * * *  -> crawl
   *   0 11 * * *  -> build the day's queue
   */
  async scheduled(event, env, ctx) {
    const db = env.DB;
    // One queue build a day; every other trigger is a crawl pass.
    const isQueueRun = event.cron === '0 11 * * *';

    // Every profile gets its own run, sequentially.
    //
    // Sequential rather than parallel on purpose: the two profiles share one
    // Workers AI account and one outbound fetch allowance, so running them at
    // once would just make them contend. Each has its own daily budget, so the
    // second profile is not starved by the first — and one failing must not
    // take the other down, hence the per-profile catch.
    ctx.waitUntil((async () => {
      for (const row of await listProfiles(db)) {
        const profile = await resolveProfile(db, row.slug);
        try {
          await (isQueueRun ? buildQueue(env, db, profile) : runCrawl(env, db, profile));
        } catch (err) {
          console.error('scheduled run failed', event.cron, row.slug, err?.stack || err);
        }
      }
    })());

    // Bounces are checked on every tick, not only the queue run: an address
    // that died should stop being usable within hours, not tomorrow. Kept in
    // its own waitUntil so a mailbox problem cannot take the crawl down.
    ctx.waitUntil(
      syncBounces(env, db).catch((err) => {
        console.error('bounce sync failed', err?.stack || err);
      })
    );
  },

  async fetch(request, env, ctx) {
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
      // No configuration hints to an unauthenticated caller.
      return json({ error: 'unavailable' }, 503);
    }

    // ---- Zoho OAuth callback --------------------------------------------
    // Outside the auth gate on purpose: Zoho sends the browser here with only
    // ?code and ?state, so requiring the dashboard key would reject the one
    // request this endpoint exists to handle. The signed state is what proves
    // the flow was started from an authenticated session.
    if (url.pathname === '/api/zoho/callback' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code) {
        return json({ connected: false, error: url.searchParams.get('error') || 'no code returned' }, 400);
      }
      if (!(await verifyState(env, state))) {
        return json({ connected: false, error: 'state invalid or expired — start again from /api/zoho/connect' }, 400);
      }

      const res = await exchangeCode(env, db, code, `${url.origin}/api/zoho/callback`);
      if (!res.ok) return json({ connected: false, error: res.error }, 400);
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Connected</title>
         <body style="font:16px/1.6 system-ui;max-width:34em;margin:18vh auto;padding:0 1em">
         <h1 style="font-size:20px">Zoho connected</h1>
         <p>Sending is now enabled. Go back to the dashboard and each lead will
         have a <b>Send it</b> button.</p></body>`,
        { status: 200, headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' } }
      );
    }

    // ---- Google sign-in -------------------------------------------------
    // These three must sit outside the auth gate, or nobody could ever reach
    // them to sign in.
    if (url.pathname.startsWith('/auth/')) {
      if (!googleConfigured(env)) {
        return json({ error: 'google sign-in is not configured' }, 503);
      }
      if (url.pathname === '/auth/login') return startLogin(env, request);
      if (url.pathname === '/auth/callback') return completeLogin(env, request);
      if (url.pathname === '/auth/logout') return logout();
      return json({ error: 'not found' }, 404);
    }

    // When REQUIRE_ACCESS is on, a request must arrive through Cloudflare
    // Access. Anything reaching the Worker another way is refused, which closes
    // the bypass that would otherwise make Access decorative.
    //
    // Deliberately placed AFTER the OAuth callbacks. Those are requests from
    // Zoho's and Google's servers, which have no Access session and never
    // could; gating them here would 403 the callback and make reconnecting
    // Zoho impossible. Each is already protected by its own signed state.
    if (env.REQUIRE_ACCESS === 'true' && !hasAccessAssertion(request)) {
      return json({ error: 'access required' }, 403);
    }

    // Three ways in, in order of preference.
    //
    // Cloudflare Access first: if it authenticated the request, that IS the
    // login and asking for anything further would be absurd. Not honouring it
    // was a real bug — Access signed people in and this Worker then refused
    // them with a bare 401.
    const viaAccess = accessUser(request);
    const signedInAs = viaAccess || await verifySession(env, sessionFrom(request));
    const hasKey = authorized(request, env);

    // A key in the query string is swapped for a session cookie and removed
    // from the address bar. Only for browser navigations — an API caller
    // using ?key= should get its response, not a redirect.
    if (!signedInAs && hasKey && url.searchParams.has('key') &&
        request.method === 'GET' &&
        (request.headers.get('accept') || '').includes('text/html')) {
      return exchangeKeyForSession(env, request.url);
    }

    if (!signedInAs && !hasKey) {
      if (!(await withinLimit(env.AUTH_LIMITER, `auth:${who}`))) return tooMany(120);
      // No sign-in page of our own.
      //
      // Cloudflare Access sits in front of leads.maledadams.work and redirects
      // an unauthenticated browser to its own login before the request ever
      // reaches this Worker. Anything arriving here without credentials is a
      // machine, or a request that bypassed Access, and either way JSON is the
      // right answer.
      return json({ error: 'unauthorized' }, 401);
    }

    // ---- which profile is this request for? -----------------------------
    //
    // ?profile= wins, then the cookie, then the default. Resolved once, here,
    // and passed down explicitly — nothing below reads an ambient current
    // profile, because a query that quietly widened to both profiles would
    // return plausible-looking rows and never error.
    const wantedProfile = url.searchParams.get('profile') || cookie(request, PROFILE_COOKIE);
    let profile;
    try {
      profile = await resolveProfile(db, wantedProfile);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 503);
    }
    const pid = profile.id;

    /**
     * Does this row belong to the profile the request is for?
     *
     * Every id-addressed write goes through this. Without it a tab left open on
     * one profile could send, skip or correct another profile's lead — the ids
     * are guessable enough and the profiles are supposed to be separate
     * accounts, so this is a boundary, not a nicety.
     */
    const ownedBy = async (table, id) => Boolean(await db.prepare(
      `SELECT 1 FROM ${table} WHERE id = ? AND profile_id = ?`
    ).bind(id, pid).first());

    try {
      // ---- dashboard ----------------------------------------------------
      //
      // One table, not four route branches, so that every page is guaranteed
      // the same nonce and the same CSP. A page that quietly rendered without
      // cspFor() would still work, which is exactly why it would go unnoticed
      // — and it displays text scraped from other people's websites.
      const view = PAGES[url.pathname];
      if (view) {
        const nonce = btoa(crypto.randomUUID()).replace(/=+$/, '');
        const sending = {
          connected: zohoConfigured(env) && await zohoConnected(db),
          sent_today: await sentToday(db),
          daily_cap: Number(env.DAILY_SEND_CAP || 30),
        };
        const html = await renderDashboard(db, env, {
          view,
          nonce,
          signedInAs,
          sending,
          profile,
          profiles: await listProfiles(db),
          env,
          calendar: view === 'calendar' ? await upcomingBookings(env) : null,
          day: url.searchParams.get('day') || todayStr(),
          page: Math.max(1, Number(url.searchParams.get('page')) || 1),
          q: (url.searchParams.get('q') || '').trim().slice(0, 80),
          from: dateParam(url.searchParams.get('from')),
          to: dateParam(url.searchParams.get('to')),
          period: PERIODS[url.searchParams.get('period')] ? url.searchParams.get('period') : 'month',
        });
        return new Response(html, {
          headers: {
            ...SECURITY_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': cspFor(nonce),
            // Switching profile in the sidebar has to stick for the API calls
            // the page then makes, which carry no query string of their own.
            ...(url.searchParams.get('profile')
              ? { 'set-cookie': `${PROFILE_COOKIE}=${encodeURIComponent(profile.slug)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` }
              : {}),
          },
        });
      }

      // ---- read ---------------------------------------------------------
      if (url.pathname === '/api/queue' && request.method === 'GET') {
        return json(await getQueue(db, pid, url.searchParams.get('day') || todayStr()));
      }

      if (url.pathname === '/api/entity' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'id required' }, 400);
        const entity = await db.prepare(
          'SELECT * FROM entities WHERE id = ? AND profile_id = ?'
        ).bind(id, pid).first();
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
          db.prepare('SELECT state, COUNT(*) n FROM entities WHERE profile_id = ? GROUP BY state').bind(pid).all(),
          db.prepare('SELECT metric, used FROM budget WHERE profile_id = ? AND day = ?').bind(pid, todayStr()).all(),
          db.prepare('SELECT status, COUNT(*) n FROM crawl_frontier WHERE profile_id = ? GROUP BY status').bind(pid).all(),
          db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT domain) d FROM entities WHERE profile_id = ?').bind(pid).first(),
        ]);
        return json({
          profile: profile.slug,
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
        return json(await ingestSeeds(db, pid, seeds, body.source || 'manual-seed'));
      }

      // The reviewer's decision. One endpoint, because sent/skipped/blocked
      // are the same event with different consequences, and every one of them
      // is a training signal.
      const decide = url.pathname.match(/^\/api\/decide\/([\w-]+)$/);
      if (decide && request.method === 'POST') {
        const outreachId = decide[1];
        const body = await request.json().catch(() => ({}));
        const decision = String(body.decision || '').toUpperCase();
        const reason = String(body.reason || '').trim();

        if (!['SENT', 'SKIPPED', 'BLOCKED'].includes(decision)) {
          return json({ error: 'decision must be SENT, SKIPPED or BLOCKED' }, 400);
        }
        if (decision !== 'SENT' && reason.length < 4) {
          return json({ error: 'a reason is required when not sending' }, 400);
        }

        const row = await db
          .prepare(`SELECT o.entity_id, e.contact_email, e.domain
                    FROM outreach o JOIN entities e ON e.id = o.entity_id
                    WHERE o.id = ? AND o.profile_id = ?`)
          .bind(outreachId, pid).first();
        if (!row) return json({ error: 'not-found' }, 404);

        if (decision === 'SENT') {
          await markSent(db, outreachId);
        } else {
          await markSkipped(db, outreachId, reason.slice(0, 120));
          if (decision === 'BLOCKED') {
            await suppress(db, row.contact_email || `domain:${row.domain}`, reason.slice(0, 200));
          }
        }

        await recordFeedback(db, {
          entityId: row.entity_id, outreachId, decision, reason,
          reviewer: signedInAs || request.headers.get('cf-access-authenticated-user-email') || 'api',
          profileId: pid,
        });

        // Rerank just this lead, now, because the reviewer told us something
        // specific about it. Learning across leads happens separately.
        let reranked = null;
        if (decision === 'SKIPPED' && reason) {
          const r = await rerankOne(env, db, row.entity_id, reason);
          if (r.ok) reranked = { from: r.from, to: r.to };
        }

        return json({ ok: true, decision, reranked });
      }

      // Fold accumulated feedback into general lessons. Cheap: one AI call
      // for a whole batch, and it applies to future evaluations only.
      if (url.pathname === '/api/run/learn' && request.method === 'POST') {
        return json(await deriveLessons(env, db, pid));
      }

      if (url.pathname === '/api/lessons' && request.method === 'GET') {
        const { results } = await db.prepare(
          `SELECT lesson, kind, niche, weight, source_count, created_at FROM lessons
           WHERE profile_id = ? AND active = 1 ORDER BY weight DESC`
        ).bind(pid).all();
        return json(results);
      }

      // Edit a draft before it goes out.
      //
      // Nothing else in the system writes subject/body after buildQueue, and
      // /api/send reads both straight from the row at send time, so an edit
      // here flows through to the recipient with no further plumbing.
      const edit = url.pathname.match(/^\/api\/outreach\/([\w-]+)\/edit$/);
      if (edit && request.method === 'POST') {
        const id = edit[1];
        const body = await request.json().catch(() => ({}));

        const row = await db.prepare(
          'SELECT status FROM outreach WHERE id = ? AND profile_id = ?'
        ).bind(id, pid).first();
        if (!row) return json({ error: 'not-found' }, 404);
        // A sent email is a record of what someone actually received. Editing
        // it would make the record a lie.
        if (row.status === 'SENT') return json({ error: 'already-sent' }, 409);

        // stripControl on a SUBJECT (collapses whitespace, kills header
        // injection); stripControlKeepLines on a BODY, where the line breaks
        // are the content and stripControl would flatten the whole email.
        const subject = stripControl(body.subject).slice(0, 200);
        let text = stripControlKeepLines(body.body).slice(0, 8000);
        if (!subject || !text) return json({ error: 'subject and body are both required' }, 400);

        // CAN-SPAM is not decorative. A reviewer trimming the email can delete
        // the opt-out and the postal address without realising they are the
        // legally required part, so put them back rather than trusting nobody
        // will.
        let footerRestored = false;
        if (!hasCanSpamFooter(text, env)) {
          text += `\n${canSpamFooter(env)}`;
          footerRestored = true;
        }

        await db.prepare('UPDATE outreach SET subject = ?, body = ?, edited_at = ? WHERE id = ?')
          .bind(subject, text, new Date().toISOString(), id).run();

        return json({ ok: true, subject, body: text, footer_restored: footerRestored });
      }

      // The address was wrong, so the business goes back in the pool rather
      // than being written off. See markBounced() for why this is not suppress().
      const bounce = url.pathname.match(/^\/api\/outreach\/([\w-]+)\/bounce$/);
      if (bounce && request.method === 'POST') {
        const id = bounce[1];
        const body = await request.json().catch(() => ({}));
        const note = String(body.note || '').trim();
        if (note.length < 4) return json({ error: 'say what the bounce said' }, 400);

        const row = await db.prepare(
          'SELECT entity_id FROM outreach WHERE id = ? AND profile_id = ?'
        ).bind(id, pid).first();
        if (!row) return json({ error: 'not-found' }, 404);

        const res = await markBounced(db, id, note.slice(0, 200));
        if (!res.ok) return json(res, 400);

        await recordFeedback(db, {
          entityId: row.entity_id, outreachId: id, decision: 'BOUNCED', reason: note,
          reviewer: signedInAs || 'dashboard', profileId: pid,
        });
        return json(res);
      }

      // Put a skipped or bounced draft back into today's queue to edit and send.
      const back = url.pathname.match(/^\/api\/outreach\/([\w-]+)\/revive$/);
      if (back && request.method === 'POST') {
        if (!(await ownedBy('outreach', back[1]))) return json({ error: 'not-found' }, 404);
        const res = await revive(db, back[1]);
        return json(res, res.ok ? 200 : (res.error === 'not-found' ? 404 : 409));
      }

      // Tell the system what it got wrong, in a sentence. The model works out
      // which fields that implies and every one is validated before it lands.
      const correct = url.pathname.match(/^\/api\/entity\/([\w-]+)\/correct$/);
      if (correct && request.method === 'POST') {
        if (!(await ownedBy('entities', correct[1]))) return json({ error: 'not-found' }, 404);
        const body = await request.json().catch(() => ({}));
        const res = await applyCorrection(env, db, correct[1], body.note, {
          reviewer: signedInAs || 'dashboard',
        });
        return json(res, res.ok ? 200 : (res.error === 'not-found' ? 404 : 400));
      }

      // Did they answer? Set by hand from the Sent page; the nightly sweep
      // fills in GHOSTED for anyone left blank past the cutoff.
      const status = url.pathname.match(/^\/api\/entity\/([\w-]+)\/status$/);
      if (status && request.method === 'POST') {
        if (!(await ownedBy('entities', status[1]))) return json({ error: 'not-found' }, 404);
        const body = await request.json().catch(() => ({}));
        const res = await setResponseStatus(db, status[1], body.status || null);
        return json(res, res.ok ? 200 : (res.error === 'not-found' ? 404 : 400));
      }

      // Runs nightly inside buildQueue; exposed so it can be run on demand.
      // Poll the mailbox label and mark whatever it can attribute. Runs on
      // every cron tick as well; exposed so it can be run on demand.
      if (url.pathname === '/api/run/bounces' && request.method === 'POST') {
        return json(await syncBounces(env, db));
      }

      if (url.pathname === '/api/run/ghost' && request.method === 'POST') {
        return json(await sweepGhosted(db, pid, Number(env.GHOST_AFTER_DAYS || 30)));
      }

      // Re-read the firma after editing it in Zoho, rather than waiting a day.
      if (url.pathname === '/api/zoho/signature' && request.method === 'GET') {
        const res = await fetchSignature(env, db, { force: url.searchParams.get('refresh') === '1' });
        return json({
          ...res,
          html: undefined,
          preview: res.html ? String(res.html).slice(0, 400) : null,
          statuses: RESPONSE_STATUSES,
        });
      }

      // A corrected address found by hand. This is the other way a bounced
      // lead comes back — the crawler finding one on a re-crawl is the first.
      const setEmail = url.pathname.match(/^\/api\/entity\/([\w-]+)\/email$/);
      if (setEmail && request.method === 'POST') {
        if (!(await ownedBy('entities', setEmail[1]))) return json({ error: 'not-found' }, 404);
        const body = await request.json().catch(() => ({}));
        const email = stripControl(body.email).toLowerCase();
        if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email) || email.length > 254) {
          return json({ error: 'that is not an email address' }, 400);
        }

        // Never re-adopt an address that already bounced or opted out.
        const blocked = await db.prepare('SELECT reason FROM suppressions WHERE key = ?')
          .bind(email).first();
        if (blocked) return json({ error: `that address is suppressed (${blocked.reason})` }, 409);

        const reachable = await canReceiveMail(db, email);
        if (!reachable.deliverable) {
          return json({ error: `that domain cannot receive mail (${reachable.detail})` }, 422);
        }

        const res = await db.prepare(
          `UPDATE entities SET contact_email = ?, contact_source = 'manual', updated_at = ?
           WHERE id = ?`
        ).bind(email, new Date().toISOString(), setEmail[1]).run();


        if (!res?.meta?.changes) return json({ error: 'not-found' }, 404);
        return json({ ok: true, contact_email: email });
      }

      const act = url.pathname.match(/^\/api\/outreach\/([\w-]+)\/(sent|skip|suppress)$/);
      if (act && request.method === 'POST') {
        const [, id, what] = act;
        if (!(await ownedBy('outreach', id))) return json({ error: 'not-found' }, 404);
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

      // ---- Zoho: connect once, then send from the dashboard ---------------
      if (url.pathname === '/api/zoho/connect' && request.method === 'GET') {
        if (!zohoConfigured(env)) {
          return json({ error: 'set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET first' }, 503);
        }
        const redirectUri = `${url.origin}/api/zoho/callback`;
        const state = await signState(env);
        return new Response(null, {
          status: 302,
          headers: { location: authorizeUrl(env, redirectUri, state), 'cache-control': 'no-store' },
        });
      }

      if (url.pathname === '/api/zoho/status' && request.method === 'GET') {
        return json({
          configured: zohoConfigured(env),
          connected: await zohoConnected(db),
          sent_today: await sentToday(db),
          daily_cap: Number(env.DAILY_SEND_CAP || 30),
        });
      }

      // Send one reviewed draft. A person pressed a button to get here.
      const send = url.pathname.match(/^\/api\/send\/([\w-]+)$/);
      if (send && request.method === 'POST') {
        const outreachId = send[1];

        const row = await db.prepare(
          `SELECT o.id, o.subject, o.body, o.status, o.entity_id, e.contact_email, e.display_name
           FROM outreach o JOIN entities e ON e.id = o.entity_id
           WHERE o.id = ? AND o.profile_id = ?`
        ).bind(outreachId, pid).first();

        if (!row) return json({ error: 'not-found' }, 404);
        // Never send the same draft twice, whatever the caller does.
        if (row.status === 'SENT') return json({ error: 'already-sent' }, 409);
        if (!row.contact_email) return json({ error: 'no-recipient' }, 400);

        // The last gate before a message leaves. Nothing reaches a recipient
        // without DNS confirming the domain can receive mail — not a revived
        // draft, not a hand-entered address, not a direct API call.
        const reachable = await canReceiveMail(db, row.contact_email);
        if (!reachable.deliverable) {
          await db.prepare('UPDATE outreach SET send_error = ? WHERE id = ?')
            .bind(`undeliverable: ${reachable.detail}`.slice(0, 300), outreachId).run();
          return json({
            error: `that domain cannot receive mail (${reachable.detail})`,
            sent: false,
          }, 422);
        }

        // A cap that a bug cannot talk its way past.
        const cap = Number(env.DAILY_SEND_CAP || 30);
        const already = await sentToday(db);
        if (already >= cap) {
          return json({ error: `daily send cap reached (${cap})`, sent_today: already }, 429);
        }

        const result = await sendMail(env, db, {
          to: row.contact_email,
          subject: row.subject,
          body: row.body,
        });

        if (!result.ok) {
          // Record the failure and leave the draft exactly as it was, so it
          // can be retried or read rather than silently lost.
          await db.prepare('UPDATE outreach SET send_error = ? WHERE id = ?')
            .bind(String(result.error).slice(0, 300), outreachId).run();
          return json({ sent: false, error: result.error }, 502);
        }

        await db.prepare("UPDATE outreach SET sent_via = 'zoho', send_error = NULL WHERE id = ?")
          .bind(outreachId).run();
        await markSent(db, outreachId);
        await recordFeedback(db, {
          entityId: row.entity_id, outreachId, decision: 'SENT', reason: null,
          reviewer: signedInAs || 'dashboard', profileId: pid,
        });

        return json({ sent: true, to: row.contact_email, sent_today: already + 1, cap });
      }

      // ---- manual triggers ----------------------------------------------
      //
      // A full crawl now takes several minutes at production batch sizes, far
      // longer than an HTTP request should be held open. So it is started in
      // the background and the caller is told where to look, exactly as the
      // cron path does. `?wait=1` keeps the old blocking behaviour for small
      // manual runs.
      if (url.pathname === '/api/run/crawl' && request.method === 'POST') {
        if (url.searchParams.get('wait') === '1') return json(await runCrawl(env, db, profile));

        ctx.waitUntil(
          runCrawl(env, db, profile).catch((err) => console.error('crawl failed', err?.stack || err))
        );
        return json({
          started: true,
          note: 'Crawl running in the background. Check /api/runs in a few minutes.',
        });
      }

      // Recent run history, so a backgrounded crawl can be checked on.
      if (url.pathname === '/api/runs' && request.method === 'GET') {
        const { results } = await db.prepare(
          `SELECT kind, started_at, finished_at, stats, error
           FROM runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT 8`
        ).bind(pid).all();
        return json((results || []).map((r) => ({
          kind: r.kind,
          started_at: r.started_at,
          finished: Boolean(r.finished_at),
          error: r.error,
          stats: safeJson(r.stats),
        })));
      }
      if (url.pathname === '/api/keywords' && request.method === 'GET') {
        const { results } = await db.prepare(
          `SELECT keyword, niche, source, status, certs_seen, domains_kept, leads_found, runs
           FROM keywords WHERE profile_id = ? ORDER BY
             CASE status WHEN 'ACTIVE' THEN 0 WHEN 'UNVALIDATED' THEN 1 ELSE 2 END,
             leads_found DESC, certs_seen DESC LIMIT 400`
        ).bind(pid).all();
        const counts = await db.prepare(
          'SELECT status, COUNT(*) n FROM keywords WHERE profile_id = ? GROUP BY status'
        ).bind(pid).all();
        return json({ counts: counts.results, keywords: results });
      }

      if (url.pathname === '/api/run/harvest' && request.method === 'POST') {
        const h = await harvestWikipedia(db, pid, env.USER_AGENT);
        const mined = await mineCorpus(db, pid);
        const minedAdded = mined.length ? await storeCandidates(db, pid, mined, 'corpus') : 0;
        return json({ wikipedia: h, corpus_terms_added: minedAdded });
      }

      if (url.pathname === '/api/run/validate' && request.method === 'POST') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 10), 40);
        const res = await validateBatch(db, pid, limit, queryCertTransparency, env.USER_AGENT);
        return json(res);
      }

      if (url.pathname === '/api/run/queue' && request.method === 'POST') {
        const dryRun = url.searchParams.get('dry') === '1';
        return json(await buildQueue(env, db, profile, { dryRun }));
      }

      // ---- profiles -----------------------------------------------------
      if (url.pathname === '/api/profiles' && request.method === 'GET') {
        return json({ active: profile.slug, profiles: await listProfiles(db) });
      }

      // A new outreach operation, described in a sentence. The model writes the
      // categories, the keywords, the scoring brief and the OSM tags; every
      // part of it is validated before a row exists.
      if (url.pathname === '/api/profiles' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const res = await createProfile(env, db, {
          name: body.name, brief: body.brief, slug: body.slug,
        });
        return json(res, res.ok ? 200 : 400);
      }

      const asDefault = url.pathname.match(/^\/api\/profiles\/([\w-]+)\/default$/);
      if (asDefault && request.method === 'POST') {
        const res = await setDefaultProfile(db, asDefault[1]);
        return json(res, res.ok ? 200 : 404);
      }

      // ---- calendar (shared across profiles) ----------------------------
      if (url.pathname === '/api/calendar' && request.method === 'GET') {
        if (!calConfigured(env)) return json({ error: 'set CAL_API_KEY first' }, 503);
        return json(await upcomingBookings(env, {
          limit: Math.min(Number(url.searchParams.get('limit')) || 25, 100),
        }));
      }

      return json({ error: 'not found', pathname: url.pathname }, 404);
    } catch (err) {
      console.error('request failed', url.pathname, err?.stack || err);
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};
