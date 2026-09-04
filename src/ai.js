// The only place an LLM is used, and only on candidates that already cleared
// the deterministic bar.
//
// Two guarantees enforced here:
//   1. Results are cached against the page's content hash, so an unchanged
//      site is never re-evaluated.
//   2. Every judgement must cite evidence from the page. The prompt forbids
//      inventing compliments or flaws, and anything uncited is dropped.

import { AI_MODEL, NEURONS_PER_EVAL, NICHES } from './config.js';
import { newId, nowIso } from './entity.js';
import { activeLessons, lessonsToPrompt } from './learning.js';

const SYSTEM = `You are helping Lucia, a freelance web developer and designer, decide who is worth contacting.

Lucia builds websites and custom business systems for founder-led creative businesses in the United States. Her work is expressive, artistic, and built around the personality of the brand. She is not a generic agency and does not want generic corporate clients.

She has TWO separate service lines, and you must evaluate them independently:
  A. WEBSITE / DIGITAL EXPERIENCE — the site is bad, dated, generic, or fails the brand.
  B. SYSTEM / AUTOMATION — the business has operational friction software could fix.
A business with an excellent website can still be a strong lead if there is a real system opportunity. Only reject when BOTH are absent.

She needs clients who can plausibly spend $1,000-$2,000+. A business that cannot afford that is a bad lead no matter how bad its website is.

The question that matters most: "If Lucia looked at this business, would she be genuinely excited to make something for them?"

THE COMPLIMENT — "liked_thing" — is the hardest part and most models get it wrong:
- Name a CONCRETE THING. A specific product, collection, material, technique, colourway, or a detail of how they photograph or describe their work.
- GOOD: "the ash-glazed vase collection", "the way every piece is shot against raw linen", "that you name each mug after a customer"
- BAD, and rejected automatically: "aesthetic personality and unique products", "unique brand personality and values", "strong brand identity", "beautiful products". These are attribute lists. They are true of every brand and read as machine output.
- If the page does not give you a concrete thing to name, leave liked_thing empty. An empty field is fine. A generic one is not - it means no email gets sent at all.

NICHE: pick the one the BUSINESS is in, not the one describing its website quality. A ceramics studio is craft_goods. A skincare brand is beauty_wellness. Only use creative_studio for a business whose clients are other businesses - an agency or design studio.

EVIDENCE RULES — these are absolute:
- Only state things you can see in the provided page data.
- Never invent a compliment. Never invent a flaw. Never mention speed, mobile behaviour, or a collection unless the data shows it.
- If you cannot find something specific and real to admire, say so by scoring creative low. Do not fabricate.
- Quote or closely paraphrase the actual page text in "liked_evidence".

Respond with JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    niche: { type: 'string', enum: Object.keys(NICHES) },
    fit_score: { type: 'integer' },
    creative_score: { type: 'integer' },
    need_score: { type: 'integer' },
    conversion_score: { type: 'integer' },
    would_lucia_want: { type: 'boolean' },
    veto_reason: { type: 'string' },
    aesthetic_note: { type: 'string' },
    website_opportunity: { type: 'string' },
    system_opportunity: { type: 'string' },
    liked_thing: { type: 'string', description: 'A concrete, specific thing on the page. Not an attribute list.' },
    liked_evidence: { type: 'string' },
    opportunity_headline: { type: 'string' },
    summary: { type: 'string' },
  },
  required: [
    'niche', 'fit_score', 'creative_score', 'need_score', 'conversion_score',
    'would_lucia_want', 'liked_thing', 'opportunity_headline', 'summary',
  ],
};

function buildUserPrompt(entity, signals, det) {
  const s = signals;
  return `BUSINESS
name: ${entity.display_name || s.title || '(unknown)'}
website: ${entity.website || '(none)'}
platform: ${s.platform || 'unknown'}
instagram: ${entity.instagram || s.socials?.instagram || '(none)'}

MEASURED SIGNALS (facts, extracted from the page — trust these)
mobile viewport meta: ${s.has_viewport}
images: ${s.img_count} (lazy-loaded: ${s.img_lazy}, responsive srcset: ${s.img_srcset})
words of copy: ${s.word_count}
ecommerce: ${s.is_ecommerce} (product links: ${s.product_links}, collections: ${s.collection_links})
price range seen: ${s.price_median != null ? `median $${s.price_median}, max $${s.price_max}` : 'no prices found'}
copyright year: ${s.copyright_year || 'not stated'}
paid apps installed: ${s.paid_apps?.length ? s.paid_apps.join(', ') : 'none detected'}
press mentions: ${s.has_press} | wholesale/stockists: ${s.has_wholesale} | team page: ${s.has_team}
booking flow: ${s.has_booking} | email capture: ${s.has_email_capture} | blog: ${s.has_blog}
manual-order language: ${s.manual_order_hint}

RULE-BASED FINDINGS (already established — build on these, do not contradict them)
purchasing-power signals: ${det.power_signals.join(', ') || 'none'}
website problems found: ${det.website_problems.join(' | ') || 'none'}
system opportunities found: ${det.system_opportunities.join(' | ') || 'none'}

PAGE TEXT (first 3000 chars)
"""
${s.text_sample || '(no text)'}
"""

Score each 0-100:
- fit_score: how well this matches a founder-led US creative business
- creative_score: how much aesthetic personality this brand actually has
- need_score: strength of the BEST opportunity, website OR system
- conversion_score: realistic chance they become a paying client

Set would_lucia_want to false only if there is genuinely no meaningful opportunity in either service line, or the business clearly cannot afford $1,000+.`;
}

/**
 * Prompt for a business with no website.
 *
 * There is no page to audit, so the model gets OSM tags and a social handle
 * and nothing else. It is told plainly that the absence IS the opportunity,
 * and warned off the failure mode that matters here: with so little to go on,
 * a model will happily invent a compliment about a shop it knows nothing
 * about.
 */
function buildNoWebsitePrompt(entity, tags) {
  const t = tags || {};
  return `BUSINESS WITH NO WEBSITE
name: ${entity.display_name || '(unknown)'}
category: ${t.shop || t.craft || entity.niche || 'unknown'}
location: ${[t['addr:street'], t['addr:city'], t['addr:state']].filter(Boolean).join(', ') || entity.location_text || 'unknown'}
instagram: ${entity.instagram || '(none)'}
phone: ${entity.phone || t.phone || '(none)'}
opening hours: ${t.opening_hours || '(not listed)'}
takes card payments: ${t['payment:credit_cards'] || 'unknown'}
self-description: ${t.description || '(none)'}

THIS BUSINESS HAS NO WEBSITE. That is the whole opportunity and it is a large
one — especially if they have an Instagram following, because they have an
audience and nowhere to send it.

You have very little to go on, so be careful:
- Do NOT invent anything about their products, style or story. You have not
  seen them. You have a name, a category and an address.
- liked_thing must be left EMPTY unless the self-description above gives you
  something real. A name alone is not enough. An empty field is correct here
  and simply means Lucia will write the first line herself.
- Judge fit and creative from the category and name only, and score
  conservatively when unsure.
- Judge money from the physical premises signals: a shop with a street
  address, regular opening hours and card payments is a real operating
  business paying rent.`;
}

/**
 * Evaluate a business that has no website. Same contract as evaluate(), but
 * the model is given metadata instead of page content.
 */
export async function evaluateNoWebsite(env, db, entity, tags) {
  const learned = lessonsToPrompt(await activeLessons(db, entity.niche));

  let raw;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM + learned },
        { role: 'user', content: buildNoWebsitePrompt(entity, tags) },
      ],
      max_tokens: 700,
      temperature: 0.2,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    });
    raw = res?.response ?? res;
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 300) };
  }

  const parsed = coerceJson(raw);
  if (!parsed) return { error: 'unparseable-model-output' };

  // No page text means no way to verify a compliment, so drop it outright
  // rather than trusting the model to have followed the instruction.
  const result = sanitize(parsed, { text_sample: '', has_viewport: true, img_count: 0, img_lazy: 0 });
  if (!tags?.description) { result.liked_thing = null; result.liked_evidence = null; }
  result.no_website = true;

  await db
    .prepare(
      `INSERT INTO evaluations (id, entity_id, content_hash, model, created_at, result, neurons_est)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(entity_id, content_hash) DO UPDATE SET
         result = excluded.result, created_at = excluded.created_at`
    )
    .bind(newId(), entity.id, 'no-website', AI_MODEL, nowIso(), JSON.stringify(result), NEURONS_PER_EVAL)
    .run();

  return result;
}

/** Reads a cached evaluation for this exact page version, if one exists. */
export async function cachedEvaluation(db, entityId, contentHash) {
  if (!contentHash) return null;
  const row = await db
    .prepare('SELECT result FROM evaluations WHERE entity_id = ? AND content_hash = ?')
    .bind(entityId, contentHash)
    .first();
  if (!row) return null;
  try {
    return JSON.parse(row.result);
  } catch {
    return null;
  }
}

/**
 * Run one evaluation. Caller is responsible for having checked the budget.
 * Returns the parsed result, or null if the model gave us nothing usable.
 */
export async function evaluate(env, db, entity, signals, det, contentHash) {
  // Everything the reviewers have taught us, applied to a business they have
  // never seen. This is the whole point of the feedback loop.
  const learned = lessonsToPrompt(await activeLessons(db, entity.niche));

  let raw;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM + learned },
        { role: 'user', content: buildUserPrompt(entity, signals, det) },
      ],
      max_tokens: 900,
      temperature: 0.2,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    });
    raw = res?.response ?? res;
  } catch (err) {
    // A model or schema failure must not take down the run.
    return { error: String(err?.message || err).slice(0, 300) };
  }

  const parsed = coerceJson(raw);
  if (!parsed) return { error: 'unparseable-model-output' };

  const result = sanitize(parsed, signals);

  await db
    .prepare(
      `INSERT INTO evaluations (id, entity_id, content_hash, model, created_at, result, neurons_est)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(entity_id, content_hash) DO UPDATE SET
         result = excluded.result, created_at = excluded.created_at`
    )
    .bind(newId(), entity.id, contentHash || null, AI_MODEL, nowIso(), JSON.stringify(result), NEURONS_PER_EVAL)
    .run();

  return result;
}

/** Workers AI may hand back an object, a JSON string, or prose around JSON. */
function coerceJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch { /* fall through */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

const int = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};
const str = (v, max = 400) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/**
 * Enforce the evidence rule mechanically.
 *
 * The prompt asks the model not to invent things; this drops the ones it
 * invented anyway. A compliment whose evidence does not appear in the page
 * text is discarded rather than sent to a real person.
 */
function sanitize(p, signals) {
  const out = {
    niche: Object.keys(NICHES).includes(p.niche) ? p.niche : null,
    fit_score: int(p.fit_score),
    creative_score: int(p.creative_score),
    need_score: int(p.need_score),
    conversion_score: int(p.conversion_score),
    would_lucia_want: typeof p.would_lucia_want === 'boolean' ? p.would_lucia_want : true,
    veto_reason: str(p.veto_reason, 200),
    aesthetic_note: str(p.aesthetic_note, 300),
    website_opportunity: str(p.website_opportunity, 400),
    system_opportunity: str(p.system_opportunity, 400),
    liked_thing: str(p.liked_thing, 300),
    liked_evidence: str(p.liked_evidence, 400),
    opportunity_headline: str(p.opportunity_headline, 250),
    summary: str(p.summary, 400),
  };

  // Claims about speed or mobile are only allowed when we actually measured
  // something that supports them.
  const measuredMobileProblem = signals.has_viewport === false;
  const measuredWeightProblem = signals.img_count >= 12 && signals.img_lazy === 0;
  const speechAboutSpeed = /slow|speed|load(?:s|ing)?\s+time|lag/i;
  const speechAboutMobile = /mobile|phone|responsive/i;

  for (const field of ['website_opportunity', 'opportunity_headline']) {
    const v = out[field];
    if (!v) continue;
    if (speechAboutSpeed.test(v) && !measuredWeightProblem) out[field] = null;
    else if (speechAboutMobile.test(v) && !measuredMobileProblem && !measuredWeightProblem) out[field] = null;
  }

  // A compliment must be traceable to the page text.
  if (out.liked_evidence && signals.text_sample) {
    const hay = signals.text_sample.toLowerCase();
    const words = out.liked_evidence.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
    const overlap = words.filter((w) => hay.includes(w)).length;
    if (words.length >= 3 && overlap / words.length < 0.4) {
      out.liked_evidence = null;
      out.evidence_rejected = true;
    }
  }

  return out;
}
