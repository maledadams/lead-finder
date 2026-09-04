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
  const stats = {
    fetched: 0, skipped_unchanged: 0, evaluated_ai: 0, cached_ai: 0,
    rejected: 0, qualified: 0, new_entities: 0, merged: 0,
    frontier_added: 0, errors: 0, no_website_scored: 0,
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
    });

    // Top the frontier up from automated sources before doing anything else,
    // so the crawl never runs dry and never needs a human to feed it.
    stats.source = await topUpFrontier(env, db, budget);

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
      if (!budget.canSpend('ai')) break;
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
async function topUpFrontier(env, db, budget) {
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
    if (!budget.canSpend('source')) break;

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
  out.ct.vocab = await maintainVocabulary(env, db, budget);

  const kwCount = Math.min(num(env, 'SOURCE_KEYWORDS_PER_RUN', 3), budget.remaining('source'));
  // Prefer harvested-and-validated terms; fall back to the bootstrap list
  // only while the keywords table is still empty.
  const active = await activeKeywords(db, kwCount);
  const picks = active.length ? active : await nextKeywords(db, kwCount);

  for (const { keyword } of picks) {
    if (!budget.canSpend('source')) break;

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
async function maintainVocabulary(env, db, budget) {
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
  if (toTest > 0) {
    out.validated = await validateBatch(
      db, toTest,
      async (kw, ua) => {
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

  const hash = await contentHash(res.html);
  const signals = extractSignals(res.html, res.finalUrl || url);

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
         (id, entity_id, url, fetched_at, http_status, ok, content_hash, bytes, ttfb_ms, signals, text_sample)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      newId(), entityId, url, nowIso(), res.status, 1, hash, res.bytes, res.ttfb,
      JSON.stringify(stripLinks(signals)), signals.text_sample
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

/** Titles are usually "Brand — tagline". Keep the brand. */
function cleanTitle(title) {
  if (!title) return null;
  const t = title.split(/\s[|–—·-]\s/)[0].trim();
  return t.length >= 2 && t.length <= 80 ? t : title.slice(0, 80) || null;
}

/** Prefer a named human over a role mailbox. */
function pickEmail(emails) {
  if (!emails?.length) return null;
  const personal = emails.find((e) => !/^(info|hello|hi|contact|support|sales|admin|orders|help|team|press|noreply|no-reply)@/i.test(e));
  return personal || emails[0];
}

/** Links are huge and only needed during the run; don't store them. */
function stripLinks(signals) {
  const { links, text_sample, ...rest } = signals;
  return rest;
}
