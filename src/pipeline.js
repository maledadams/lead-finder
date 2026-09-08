// The staged crawl. Runs on cron with the laptop off.
//
// Stage order is the cost-control strategy, and it is strict:
//
//   dedup (D1 lookup)      -> free
//   fetch + extract        -> cheap, cached by content hash
//   hard filters           -> free
//   deterministic score    -> free
//   AI evaluation          -> expensive, only for candidates above the bar
//
// Anything that can be decided by a rule is decided by a rule.

import { num, STATES, NICHES, DEFAULT_NICHE } from './config.js';
import { Budget } from './budget.js';
import { Fetcher, contentHash } from './fetcher.js';
import { extractSignals, guessNiche } from './extract.js';
import { needsBrowser, renderPage } from './render.js';
import { hardFilter, deterministicScore, finalScore, scoreWithoutWebsite } from './score.js';
import { cachedEvaluation, evaluate, evaluateNoWebsite } from './ai.js';
import {
  addToFrontier, markFrontier, selectPeerLinks, staleEntities, takeFrontierBatch,
} from './discover.js';
import { nextKeywords, queryCertTransparency, recordKeywordRun } from './sources.js';
import { flagCrossMetroChains, nextMetros, queryMetro, recordMetroRun } from './osm.js';
import {
  activeKeywords, demoteUnproductive, harvestWikipedia, mineCorpus, recordUse,
  storeCandidates, validateBatch,
} from './keywords.js';
import { ingestSeeds } from './discover.js';
import { newId, nowIso, normalizeUrl, resolveEntity } from './entity.js';

export async function runCrawl(env, db) {
  const runId = newId();
  const startedAt = nowIso();

  // Wall-clock deadline, not just a budget.
  //
  // Run history showed crawls finishing in 118-390s, and anything longer being
  // killed by the runtime mid-flight: the run row was left open forever and
  // its work went unrecorded. Budgets alone cannot prevent that, because a run
  // can be slow without being large.
  //
  // So a pass stops cleanly when time runs short and records what it did. The
  // frontier is persistent, so the next scheduled pass simply carries on —
  // which is why there are several crawl triggers a day rather than one.
  const runSeconds = num(env, 'MAX_RUN_SECONDS', 200);
  const startMs = Date.now();
  const deadline = startMs + runSeconds * 1000;
  const outOfTime = () => Date.now() > deadline;

  // Each phase gets its own slice, because they compete for the same clock and
  // the ones that run first would otherwise starve the ones that matter most.
  //
  // Measured: with only a single overall deadline, a 60s pass spent everything
  // on discovery and website-less scoring and fetched ZERO pages — the actual
  // auditing never ran. Discovery is worthless if nothing is ever audited.
  const discoveryDeadline = startMs + Math.round(runSeconds * 0.30) * 1000;
  const noSiteDeadline = startMs + Math.round(runSeconds * 0.50) * 1000;
  const discoveryOutOfTime = () => Date.now() > discoveryDeadline;
  const noSiteOutOfTime = () => Date.now() > noSiteDeadline;
  const stats = {
    fetched: 0, skipped_unchanged: 0, evaluated_ai: 0, cached_ai: 0,
    rejected: 0, qualified: 0, new_entities: 0, merged: 0,
    frontier_added: 0, errors: 0, no_website_scored: 0,
    contact_fetched: 0, contact_emails_found: 0,
  };

  await db
    .prepare('INSERT INTO runs (id, kind, started_at) VALUES (?, ?, ?)')
    .bind(runId, 'crawl', startedAt)
    .run();

  try {
    const budget = await Budget.load(db, {
      fetch: num(env, 'DAILY_FETCH_BUDGET', 300),
      ai: num(env, 'DAILY_AI_BUDGET', 40),
      source: num(env, 'DAILY_SOURCE_QUERIES', 8),
      browser: num(env, 'DAILY_BROWSER_RENDERS', 20),
    });

    // Top the frontier up from automated sources before doing anything else,
    // so the crawl never runs dry and never needs a human to feed it.
    stats.source = await topUpFrontier(env, db, budget, discoveryOutOfTime);

    const fetcher = new Fetcher(env.USER_AGENT);
    const minPrescore = num(env, 'MIN_PRESCORE_FOR_AI', 45);
    const minQueue = num(env, 'MIN_SCORE_TO_QUEUE', 68);
    const reEvalDays = num(env, 'RE_EVAL_AFTER_DAYS', 45);
    const batchSize = Math.min(num(env, 'CRAWL_FRONTIER_BATCH', 60), budget.remaining('fetch'));

    // Split the run: mostly new discovery, a steady minority re-checking the
    // pool we already have. Both feed the same daily queue.
    const newShare = Math.ceil(batchSize * 0.7);
    const staleShare = Math.max(0, batchSize - newShare);

    const frontier = await takeFrontierBatch(db, newShare);
    const stale = staleShare
      ? await staleEntities(db, {
          days: reEvalDays,
          nearMissFrom: Math.max(0, minQueue - 12),
          nearMissTo: minQueue - 1,
          limit: staleShare,
        })
      : [];

    // Businesses with no website never enter the frontier — there is nothing
    // to fetch — so they are pulled separately and scored from OSM metadata.
    const noSite = await db
      .prepare(
        `SELECT id, display_name, instagram, phone, osm_tags, niche, contact_email,
                location_text, score, state, last_evaluated_at
         FROM entities
         WHERE has_website = 0
           AND state NOT IN ('CONTACTED','REPLIED','CONVERSATION','CLIENT','DO_NOT_CONTACT','REJECTED')
           AND (last_evaluated_at IS NULL OR last_evaluated_at < ?)
         ORDER BY COALESCE(last_evaluated_at, '') ASC
         LIMIT ?`
      )
      .bind(new Date(Date.now() - reEvalDays * 86400_000).toISOString(),
            num(env, 'NO_SITE_BATCH', 15))
      .all();

    for (const e of noSite.results || []) {
      if (!budget.canSpend('ai') || noSiteOutOfTime()) break;
      try {
        await processNoWebsite(env, db, { entity: e, budget, stats, minQueue });
      } catch (err) {
        stats.errors++;
        console.error('processNoWebsite failed', e.id, err?.message);
      }
    }

    const targets = [
      ...frontier.map((f) => ({ kind: 'frontier', url: f.url, row: f })),
      ...stale.map((e) => ({ kind: 'stale', url: e.website, row: e })),
    ];

    for (const target of targets) {
      if (!budget.canSpend('fetch')) break;
      if (outOfTime()) { stats.stopped_on_time = true; break; }
      const url = normalizeUrl(target.url);
      if (!url) {
        if (target.kind === 'frontier') await markFrontier(db, target.url, 'SKIPPED');
        continue;
      }

      try {
        await processOne(env, db, { fetcher, budget, target, url, stats, minPrescore, minQueue });
      } catch (err) {
        stats.errors++;
        if (target.kind === 'frontier') await markFrontier(db, target.url, 'ERROR');
        console.error('processOne failed', url, err?.message);
      }
    }

    await budget.flush();
    stats.budget = budget.summary();
    stats.elapsed_s = Math.round((Date.now() - startMs) / 1000);

    await db
      .prepare('UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?')
      .bind(nowIso(), JSON.stringify(stats), runId)
      .run();

    return stats;
  } catch (err) {
    await db
      .prepare('UPDATE runs SET finished_at = ?, error = ?, stats = ? WHERE id = ?')
      .bind(nowIso(), String(err?.message || err).slice(0, 500), JSON.stringify(stats), runId)
      .run();
    throw err;
  }
}

/**
 * Refill the crawl frontier from Certificate Transparency logs.
 *
 * Runs only when the frontier is genuinely low, so a healthy link graph does
 * the work and the CT sweep is a floor rather than the main channel. Keywords
 * rotate least-recently-used, so the whole list gets covered over time.
 */
async function topUpFrontier(env, db, budget, outOfTime = () => false) {
  const out = {
    osm: { metros: [], businesses: 0, new_entities: 0, errors: 0 },
    ct: { keywords: [], domains_found: 0, frontier_added: 0, errors: 0 },
  };

  const lowWater = num(env, 'FRONTIER_LOW_WATER', 150);
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM crawl_frontier WHERE status = 'PENDING'")
    .first();

  if (!budget.canSpend('source')) return { ...out, skipped: 'source-budget-exhausted' };

  const frontierHealthy = (pending?.n || 0) >= lowWater;

  // The OSM sweep is NOT gated on frontier depth, and that is deliberate.
  //
  // It finds a population the frontier can never contain: businesses with no
  // website. There is no URL to queue for them, so if OSM only ran when the
  // crawl was starving, those leads — often the strongest ones — would simply
  // never be discovered. It runs on its own cadence instead: whenever a metro
  // has not been swept recently.
  // --- OpenStreetMap first ------------------------------------------------
  // Higher quality than the CT sweep: every record arrives with a name, a
  // category, and a verified US street address, so geography is established
  // as fact before we spend a fetch on it.
  const metroCount = Math.min(num(env, 'SOURCE_METROS_PER_RUN', 2), budget.remaining('source'));
  const due = await nextMetros(db, metroCount);
  if (!due.length && frontierHealthy) return { ...out, skipped: 'all-metros-swept-recently' };

  for (const { metro, bbox } of due) {
    // Overpass and crt.sh are slow enough that discovery alone can consume a
    // whole pass. Checking the clock here is what keeps the fetch loop from
    // being starved of time by the sources that feed it.
    if (!budget.canSpend('source') || outOfTime()) break;

    const { candidates, error } = await queryMetro(metro, bbox, env.USER_AGENT);
    budget.spend('source');
    out.osm.metros.push(metro);

    if (error) {
      out.osm.errors++;
      out.osm.last_error = `${metro}: ${error}`;
      await recordMetroRun(db, metro, 0);
      continue;
    }

    out.osm.businesses += candidates.length;
    // Full ingest rather than a bare frontier push, so the name, niche and
    // location survive into the entity record.
    const res = await ingestSeeds(db, candidates, `osm:${metro}`);
    out.osm.new_entities += res.accepted;
    await recordMetroRun(db, metro, res.accepted);
  }

  // Chains that OSM never tagged reveal themselves by appearing in several
  // cities at once. Cheap to check and needs no list to maintain.
  if (out.osm.metros.length) {
    const chains = await flagCrossMetroChains(db);
    out.osm.chains_flagged = chains.flagged;
  }

  // --- Certificate Transparency, to top up if still thin ------------------
  // Unlike OSM, this only produces URLs, so frontier depth is the right gate.
  const stillPending = await db
    .prepare("SELECT COUNT(*) AS n FROM crawl_frontier WHERE status = 'PENDING'")
    .first();
  if ((stillPending?.n || 0) >= lowWater) return out;

  // Keep the vocabulary fed and measured before spending queries on it.
  out.ct.vocab = await maintainVocabulary(env, db, budget, outOfTime);

  const kwCount = Math.min(num(env, 'SOURCE_KEYWORDS_PER_RUN', 3), budget.remaining('source'));
  // Prefer harvested-and-validated terms; fall back to the bootstrap list
  // only while the keywords table is still empty.
  const active = await activeKeywords(db, kwCount);
  const picks = active.length ? active : await nextKeywords(db, kwCount);

  for (const { keyword } of picks) {
    if (!budget.canSpend('source') || outOfTime()) break;

    const { domains, error } = await queryCertTransparency(keyword, env.USER_AGENT);
    budget.spend('source');
    out.ct.keywords.push(keyword);

    if (error) { out.ct.errors++; await recordKeywordRun(db, keyword, 0); continue; }

    out.ct.domains_found += domains.length;
    const added = await addToFrontier(
      db,
      domains.map((d) => ({
        url: `https://${d}`,
        priority: 40,                       // below a strong peer link, above a weak one
        depth: 0,
        reason: `ct:${keyword}`,
      })),
      null
    );
    out.ct.frontier_added += added;
    await recordKeywordRun(db, keyword, added);
    await recordUse(db, keyword, added);
  }

  return out;
}

/**
 * Keep the keyword vocabulary growing and honest.
 *
 * Harvest runs once, when the table is empty. Validation runs a few terms per
 * crawl, so the cost is spread out and a term is never used before its real
 * yield is known. Corpus mining kicks in once there are enough scored pages
 * to learn from.
 */
async function maintainVocabulary(env, db, budget, outOfTime = () => false) {
  const out = { harvested: 0, mined: 0, validated: null };

  const have = await db.prepare('SELECT COUNT(*) AS n FROM keywords').first();

  if ((have?.n || 0) === 0) {
    const h = await harvestWikipedia(db, env.USER_AGENT);
    out.harvested = h.added;
    if (h.errors.length) out.harvest_errors = h.errors.slice(0, 3);
  }

  // Learn from our own good leads. Cheap: it is a DB query, not a fetch.
  const mined = await mineCorpus(db);
  if (mined.length) out.mined = await storeCandidates(db, mined, 'corpus');

  // Retire terms that keep returning domains but never produce a lead.
  const demoted = await demoteUnproductive(db);
  if (demoted.demoted) out.demoted = demoted.demoted;

  // Measure a few unvalidated terms per run, within the source budget.
  const toTest = Math.min(num(env, 'KEYWORDS_VALIDATED_PER_RUN', 3), budget.remaining('source'));
  if (toTest > 0 && !outOfTime()) {
    out.validated = await validateBatch(
      db, toTest,
      async (kw, ua) => {
        if (outOfTime()) return { domains: [], error: 'out-of-time' };
        budget.spend('source');
        return queryCertTransparency(kw, ua);
      },
      env.USER_AGENT
    );
  }

  return out;
}

async function processOne(env, db, ctx) {
  const { fetcher, budget, target, url, stats, minPrescore, minQueue } = ctx;

  const res = await fetcher.get(url);
  budget.spend('fetch');
  stats.fetched++;

  if (!res.ok) {
    if (target.kind === 'frontier') {
      await markFrontier(db, target.url, res.error === 'robots-disallow' ? 'SKIPPED' : 'ERROR');
    }
    if (target.kind === 'stale' && target.row?.id) {
      // Site is down or gone. Note it, do not delete — it may come back.
      await db
        .prepare('UPDATE entities SET last_evaluated_at = ?, updated_at = ? WHERE id = ?')
        .bind(nowIso(), nowIso(), target.row.id)
        .run();
    }
    return;
  }

  let html = res.html;
  let renderMode = 'static';
  let signals = extractSignals(html, res.finalUrl || url);

  // A JS-rendered site looks identical to a dead one through a plain fetch.
  // Escalate to a real browser only for those, and only within its own cap.
  if (needsBrowser(signals, html) && budget.canSpend('browser')) {
    const rendered = await renderPage(env, res.finalUrl || url);
    budget.spend('browser');
    stats.browser_rendered = (stats.browser_rendered || 0) + 1;
    if (rendered.html) {
      html = rendered.html;
      renderMode = 'browser';
      signals = extractSignals(html, res.finalUrl || url);
    } else {
      stats.browser_errors = (stats.browser_errors || 0) + 1;
    }
  }

  const hash = await contentHash(html);

  // --- resolve to an entity (dedup happens here) ------------------------
  let entityId = target.kind === 'stale' ? target.row.id : null;
  if (!entityId) {
    const resolved = await resolveEntity(db, {
      website: res.finalUrl || url,
      display_name: signals.og_site_name || cleanTitle(signals.title) || null,
      instagram: signals.socials?.instagram,
      tiktok: signals.socials?.tiktok,
      etsy: signals.socials?.etsy,
      contact_email: pickEmail(signals.emails),
      contact_source: signals.emails?.length ? 'website' : null,
      discovery_source: target.row?.reason || 'link-graph',
      discovered_via: target.row?.parent_entity || null,
      country: 'US',
    });
    entityId = resolved.id;
    if (resolved.created) stats.new_entities++;
    stats.merged += resolved.merged || 0;
  }
  if (!entityId) {
    if (target.kind === 'frontier') await markFrontier(db, target.url, 'SKIPPED');
    return;
  }

  const entity = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(entityId).first();
  if (!entity) return;

  // --- compute cache: unchanged page, recent evaluation, nothing to do ---
  const lastSnap = await db
    .prepare('SELECT content_hash FROM snapshots WHERE entity_id = ? ORDER BY fetched_at DESC LIMIT 1')
    .bind(entityId)
    .first();

  const unchanged = lastSnap?.content_hash === hash;
  const cachedAi = await cachedEvaluation(db, entityId, hash);

  await db
    .prepare(
      `INSERT INTO snapshots
         (id, entity_id, url, fetched_at, http_status, ok, content_hash, bytes,
          ttfb_ms, signals, text_sample, render_mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      newId(), entityId, url, nowIso(), res.status, 1, hash, res.bytes, res.ttfb,
      JSON.stringify(stripLinks(signals)), signals.text_sample, renderMode
    )
    .run();

  if (target.kind === 'frontier') await markFrontier(db, target.url, 'DONE');

  // --- link-graph expansion (do this even if we skip scoring) -----------
  const depth = target.row?.depth ?? 0;
  if (depth < 3) {
    const peers = selectPeerLinks(signals, url, depth);
    stats.frontier_added += await addToFrontier(db, peers, entityId);
  }

  if (unchanged && cachedAi && entity.score != null) {
    stats.skipped_unchanged++;
    await db
      .prepare('UPDATE entities SET last_evaluated_at = ?, updated_at = ? WHERE id = ?')
      .bind(nowIso(), nowIso(), entityId)
      .run();
    return;
  }

  // --- chase a contact page if we still have no email --------------------
  //
  // The single biggest bottleneck measured in production: of 120 leads
  // considered for one queue, 66 were dropped purely because no email was
  // found. Most independent sites keep contact details off the homepage, so
  // one extra fetch of /contact or /about recovers a large share of them.
  //
  // Only for candidates that already look worth it, so the extra fetch is
  // never spent on a business we were going to reject anyway.
  // Chase when there is no address at all, and also when the only thing found
  // is a poor one. A homepage offering nothing but orders@ or careers@ has not
  // really given us a way to reach anyone, and the contact page usually carries
  // the address the business actually wants used.
  const onlyPoor = Boolean(signals.emails?.length)
    && signals.emails.every((e) => WRONG_DEPARTMENT.test(e) || AUTOMATED.test(e));

  if ((!signals.emails?.length || onlyPoor) && signals.contact_links?.length && budget.canSpend('fetch')) {
    const extra = await chaseContactPage(fetcher, signals.contact_links, res.finalUrl || url, {
      tries: 2, budget,
    });
    stats.contact_fetched = (stats.contact_fetched || 0) + 1;
    if (extra.emails.length) {
      // Merge rather than replace: the homepage address may still be the best
      // one, and pickEmail ranks the whole set. Footer addresses lead.
      signals.emails = [...new Set([
        ...(extra.footer_emails || []), ...extra.emails, ...(signals.emails || []),
      ])];
      signals.contact_source_url = extra.url;
      stats.contact_emails_found = (stats.contact_emails_found || 0) + 1;
    }
  }

  // --- hard filters -----------------------------------------------------
  const gate = hardFilter(signals, entity);
  if (!gate.pass) {
    stats.rejected++;
    await db
      .prepare(
        `UPDATE entities SET state = ?, reject_reason = ?, last_evaluated_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(STATES.REJECTED, gate.reason, nowIso(), nowIso(), entityId)
      .run();
    return;
  }

  // --- deterministic scoring -------------------------------------------
  const det = deterministicScore(signals, entity);
  const niche = entity.niche || guessNiche(signals, NICHES, DEFAULT_NICHE);

  // --- AI, only above the bar and only if budget allows ------------------
  let ai = cachedAi;
  if (!ai && det.prescore >= minPrescore && budget.canSpend('ai')) {
    ai = await evaluate(env, db, { ...entity, niche }, signals, det, hash);
    budget.spend('ai');
    stats.evaluated_ai++;
    if (ai?.error) { ai = null; stats.errors++; }
  } else if (ai) {
    stats.cached_ai++;
  }

  const final = finalScore(det, ai);

  let state = STATES.EVALUATED;
  if (final.score >= minQueue) { state = STATES.QUALIFIED; stats.qualified++; }
  else if (final.score >= minQueue - 15) state = STATES.NURTURE;
  else if (final.vetoed) state = STATES.REJECTED;
  else state = STATES.NOT_NOW;

  // Never downgrade an entity that is already further along the funnel.
  const advanced = ['SHORTLISTED', 'OUTREACH_READY', 'CONTACTED', 'REPLIED', 'CONVERSATION', 'CLIENT', 'DO_NOT_CONTACT'];
  if (advanced.includes(entity.state)) state = entity.state;

  await db
    .prepare(
      `UPDATE entities SET
         state = ?, score = ?, score_reason = ?, niche = ?,
         website_opportunity = ?, system_opportunity = ?,
         power_signals = ?, creative_signals = ?, personalization = ?,
         contact_email = COALESCE(contact_email, ?),
         contact_source = COALESCE(contact_source, ?),
         display_name = COALESCE(display_name, ?),
         reject_reason = ?, last_evaluated_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      state,
      final.score,
      final.reason?.slice(0, 500) || null,
      // The classifier wins over the model on niche.
      //
      // In production the model tagged Heath Ceramics AND a skincare brand as
      // `creative_studio`, so both got the agency persona - "you clearly do
      // this well for clients" addressed to a ceramics company. An OSM
      // category or page-text match is concrete evidence; the model's guess
      // is not, so it is only used when we have nothing better.
      entity.niche || niche || ai?.niche,
      ai?.website_opportunity || det.website_problems.join(' | ') || null,
      ai?.system_opportunity || det.system_opportunities.join(' | ') || null,
      JSON.stringify(det.power_signals),
      JSON.stringify([ai?.aesthetic_note].filter(Boolean)),
      JSON.stringify({
        liked: ai?.liked_thing || null,
        evidence: ai?.liked_evidence || null,
        opportunity: ai?.opportunity_headline || null,
        evidence_rejected: ai?.evidence_rejected || false,
      }),
      pickEmail(signals.emails),
      signals.emails?.length ? 'website' : null,
      signals.og_site_name || cleanTitle(signals.title) || null,
      final.vetoed ? (ai?.veto_reason || 'ai-veto') : null,
      nowIso(),
      nowIso(),
      entityId
    )
    .run();
}

/**
 * Score a business that has no website.
 *
 * No fetch, no page, no hard filter that depends on page content. The whole
 * judgement rests on OSM tags plus one AI call, so this is cheap in fetch
 * budget and only costs AI.
 */
async function processNoWebsite(env, db, { entity, budget, stats, minQueue }) {
  let tags = {};
  try { tags = JSON.parse(entity.osm_tags || '{}'); } catch { /* keep {} */ }

  const det = scoreWithoutWebsite(entity, tags);

  const cached = await cachedEvaluation(db, entity.id, 'no-website');
  let ai = cached;
  if (!ai && budget.canSpend('ai')) {
    ai = await evaluateNoWebsite(env, db, entity, tags);
    budget.spend('ai');
    stats.evaluated_ai++;
    if (ai?.error) { ai = null; stats.errors++; }
  } else if (ai) {
    stats.cached_ai++;
  }

  const final = finalScore(det, ai);
  stats.no_website_scored++;

  let state = STATES.EVALUATED;
  if (final.score >= minQueue) { state = STATES.QUALIFIED; stats.qualified++; }
  else if (final.score >= minQueue - 15) state = STATES.NURTURE;
  else if (final.vetoed) state = STATES.REJECTED;
  else state = STATES.NOT_NOW;

  const advanced = ['SHORTLISTED', 'OUTREACH_READY', 'CONTACTED', 'REPLIED', 'CONVERSATION', 'CLIENT', 'DO_NOT_CONTACT'];
  if (advanced.includes(entity.state)) state = entity.state;

  await db
    .prepare(
      `UPDATE entities SET
         state = ?, score = ?, score_reason = ?, niche = COALESCE(niche, ?),
         website_opportunity = ?, system_opportunity = ?,
         power_signals = ?, personalization = ?,
         last_evaluated_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      state,
      final.score,
      final.reason?.slice(0, 500) || null,
      ai?.niche || entity.niche || null,
      det.website_problems.join(' | '),
      det.system_opportunities.join(' | '),
      JSON.stringify(det.power_signals),
      JSON.stringify({
        liked: ai?.liked_thing || null,
        evidence: ai?.liked_evidence || null,
        opportunity: ai?.opportunity_headline || null,
        no_website: true,
      }),
      nowIso(), nowIso(), entity.id
    )
    .run();
}

/**
 * Fetch the most promising contact page and pull addresses out of it.
 *
 * Tries one page, not all of them: the second-best candidate is rarely worth
 * another fetch, and the budget is better spent on a different business.
 */
/**
 * Fetch the likeliest contact pages until one yields an address.
 *
 * Only the top candidate used to be tried, so a site whose /contact page is a
 * form and whose /about page carries the address gave up after one fetch. Each
 * attempt costs a fetch from the budget, so the caller decides how many.
 */
async function chaseContactPage(fetcher, candidates, baseUrl, { tries = 2, budget = null } = {}) {
  for (const target of (candidates || []).slice(0, tries)) {
    if (budget && !budget.canSpend('fetch')) break;
    const res = await fetcher.get(target);
    if (budget) budget.spend('fetch');
    if (!res.ok || !res.html) continue;

    const sub = extractSignals(res.html, res.finalUrl || target);
    if (sub.emails?.length) {
      return { emails: sub.emails, footer_emails: sub.footer_emails || [], url: target };
    }
  }
  return { emails: [], footer_emails: [], url: null };
}

/** Titles are usually "Brand — tagline". Keep the brand. */
function cleanTitle(title) {
  if (!title) return null;
  const t = title.split(/\s[|–—·-]\s/)[0].trim();
  return t.length >= 2 && t.length <= 80 ? t : title.slice(0, 80) || null;
}

/**
 * Pick the best address to write to.
 *
 * Three tiers, because not all role addresses are equal. A live queue put
 * `hr@nwframing.com` on a design pitch — recruitment is the wrong department
 * and the wrong impression. Those are excluded outright rather than merely
 * ranked last; better no email, and the lead waits, than a pitch to payroll.
 */
const WRONG_DEPARTMENT =
  /^(?:hr|jobs|careers|recruit\w*|hiring|billing|accounts?|accounting|invoices?|payroll|legal|compliance|privacy|dpo|security|abuse|webmaster|postmaster|noreply|no-?reply|donotreply|unsubscribe|returns|shipping|warranty|wholesale-?apply)@/i;

// Addresses a machine sends FROM, or a shopping cart owns. Nobody reads these.
//
// checkout@ was being chosen over hello@ — not because it scored better, but
// because the old rule treated anything it did not recognise as a person, and
// it did not recognise "checkout". The list of things that are not people has
// to be the explicit one.
const AUTOMATED =
  /^(?:checkout|cart|basket|order-?status|orderstatus|tracking|newsletter|subscribe|subscriptions?|notifications?|alerts?|mailer|mailer-?daemon|bounces?|automated|system|robot|bot|daemon|noreply\d*|updates?|digest|receipts?|confirm\w*)@/i;

// General inboxes a human really does read, best first. Not disqualifying —
// for a small studio hello@ is often the only address there is.
const GENERAL_INBOX = [
  /^hello@/i, /^hi@/i, /^hey@/i, /^contact@/i, /^info@/i,
  /^enquir\w*@/i, /^inquir\w*@/i, /^studio@/i, /^team@/i, /^office@/i,
  /^ask@/i, /^talk@/i, /^hq@/i, /^shop@/i, /^mail@/i, /^admin@/i,
  /^support@/i, /^help@/i, /^press@/i, /^media@/i, /^orders?@/i, /^sales@/i,
];

/** Anything not on a known role list is treated as possibly a person. */
const ROLEISH = new RegExp(
  `${WRONG_DEPARTMENT.source.slice(0, -1)}|${AUTOMATED.source.slice(0, -1)}|`
  + GENERAL_INBOX.map((r) => r.source.slice(0, -1)).join('|'),
  'i'
);

/**
 * Which address to actually write to.
 *
 * Ranked rather than filtered, because "not a role address" is not the same as
 * "a person" — that assumption is what put shopping-cart addresses at the top.
 */
function pickEmail(emails) {
  const usable = (emails || []).filter(
    (e) => e && !WRONG_DEPARTMENT.test(e) && !AUTOMATED.test(e)
  );
  if (!usable.length) return null;

  const rank = (e) => {
    // A local part that matches no known role, carries no digits and is not a
    // catch-all is most likely a human being.
    if (!ROLEISH.test(e) && !/^\S*\d/.test(e) && !/^(?:all|everyone|everybody)@/i.test(e)) return 0;
    const i = GENERAL_INBOX.findIndex((rx) => rx.test(e));
    return i === -1 ? 1 + GENERAL_INBOX.length : 1 + i;
  };

  return [...usable].sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0];
}

/** Links are huge and only needed during the run; don't store them. */
function stripLinks(signals) {
  const { links, text_sample, ...rest } = signals;
  return rest;
}
