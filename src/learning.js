// The feedback loop.
//
// Every time a reviewer skips a lead and says why, that reason is a better
// signal than anything hard-coded here: it is Lucia's actual taste, stated in
// words, about a specific real business.
//
// How it is used, and deliberately not used:
//
//   APPLIED FORWARD.  Lessons are injected into the evaluation prompt, so the
//   model applies them to businesses it has not seen yet.
//
//   NOT APPLIED BACKWARD. Nothing re-scores the existing database. Re-running
//   thousands of AI calls every time someone types a sentence would be
//   expensive and would churn scores under the reviewer's feet. An old lead
//   picks up the new understanding only when it comes round again for
//   re-evaluation on its own schedule.
//
//   RERANKED IMMEDIATELY, once, for the lead the feedback was about — because
//   the reviewer just told us something specific about that business.

import { newId, nowIso } from './entity.js';
import { AI_MODEL } from './config.js';

// A rerank can lower a lead a long way but never erase it.
const RERANK_FLOOR = 15;

/** Record a decision. Returns the feedback row id. */
export async function recordFeedback(db, { entityId, outreachId, decision, reason, reviewer, profileId }) {
  // Unattributed feedback is feedback that disappears: lessons, metrics and the
  // ranking all read this table per profile, so a row with no profile would be
  // written, counted nowhere, and never noticed.
  if (!profileId) throw new Error('recordFeedback needs a profileId');
  const entity = await db
    .prepare('SELECT score, niche, profile_id FROM entities WHERE id = ?')
    .bind(entityId)
    .first();

  const id = newId();
  await db
    .prepare(
      `INSERT INTO feedback
         (id, profile_id, entity_id, outreach_id, decision, reason, reviewer,
          score_at_time, niche_at_time, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id, profileId || entity?.profile_id || null,
      entityId, outreachId || null, decision,
      (reason || '').slice(0, 600) || null, reviewer || null,
      entity?.score ?? null, entity?.niche ?? null, nowIso()
    )
    .run();

  return id;
}

/**
 * Turn unapplied feedback into lessons.
 *
 * One AI call for a whole batch, not one per item — the point is to find the
 * pattern across several rejections, which is also what makes it cheap.
 */
export async function deriveLessons(env, db, profileId, { minBatch = 3, limit = 25 } = {}) {
  if (!profileId) throw new Error('deriveLessons needs a profileId');
  // BOUNCED and CORRECTED are excluded on purpose. Neither is a judgement about
  // whether a lead was worth contacting. A bounce is a fact about an address,
  // and a correction is a fact about the record — "it sells tea, not skincare"
  // would otherwise be read as a reason to avoid tea shops.
  //
  // A correction still teaches: it rewrites the record and clears
  // last_evaluated_at, so the lead is re-scored as the business it actually is.
  //
  // NOTE is the other half of that. A note that changed no field was not
  // fixing data — it was the reviewer saying something about whether this lead
  // is worth having, which is exactly what the ranking is built from. Those are
  // read here alongside skip reasons.
  const { results } = await db
    .prepare(
      `SELECT f.id, f.decision, f.reason, f.niche_at_time, f.score_at_time,
              e.display_name, e.website, e.website_opportunity, e.system_opportunity
       FROM feedback f JOIN entities e ON e.id = f.entity_id
       WHERE f.profile_id = ?
         AND f.applied = 0 AND f.reason IS NOT NULL AND length(f.reason) > 3
         AND f.decision NOT IN ('BOUNCED','CORRECTED')
       ORDER BY f.created_at LIMIT ?`
    )
    .bind(profileId, limit)
    .all();

  const rows = results || [];
  if (rows.length < minBatch) return { derived: 0, pending: rows.length, skipped: 'not-enough-feedback' };

  const listing = rows.map((r, i) =>
    `${i + 1}. ${r.decision} — "${r.display_name || 'unnamed'}"` +
    ` (niche: ${r.niche_at_time || '?'}, score: ${r.score_at_time ?? '?'})` +
    `\n   reviewer said: ${r.reason}`
  ).join('\n');

  const prompt = `A reviewer has been going through prospect leads for Lucia, a freelance web designer who works with founder-led creative businesses. Here are their recent decisions and the reasons they gave.

${listing}

Extract the GENERAL RULES behind these decisions, so future leads can be judged the same way.

Rules:
- Only state a rule if at least two decisions point to it, or one states something unmistakably general.
- Write each as a short instruction, in the reviewer's own terms. "Skip businesses whose website is already excellent and who show no operational friction" — not "the user disliked lead 3".
- Do not restate things about one specific business.
- kind is "AVOID" for what to score down, "PREFER" for what to score up.
- If a rule clearly applies to only one niche, name it; otherwise leave niche null.
- Return at most 5 rules. Fewer is fine. An empty list is fine.

Respond with JSON: {"lessons":[{"lesson":"...","kind":"AVOID|PREFER","niche":null}]}`;

  let raw;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            lessons: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  lesson: { type: 'string' },
                  kind: { type: 'string', enum: ['AVOID', 'PREFER'] },
                  niche: { type: 'string' },
                },
                required: ['lesson', 'kind'],
              },
            },
          },
          required: ['lessons'],
        },
      },
    });
    raw = res?.response ?? res;
  } catch (err) {
    return { derived: 0, error: String(err?.message || err).slice(0, 200) };
  }

  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  const lessons = Array.isArray(parsed?.lessons) ? parsed.lessons : [];

  let derived = 0;
  for (const l of lessons.slice(0, 5)) {
    const text = String(l?.lesson || '').trim().slice(0, 300);
    if (text.length < 12) continue;
    await upsertLesson(db, profileId, text, l.kind === 'PREFER' ? 'PREFER' : 'AVOID', l.niche || null);
    derived++;
  }

  // Mark the batch applied whether or not it produced a rule, so the same
  // feedback is not reprocessed on every run.
  await db.batch(
    rows.map((r) => db.prepare('UPDATE feedback SET applied = 1 WHERE id = ?').bind(r.id))
  );

  return { derived, from_feedback: rows.length };
}

/**
 * Store a lesson, or strengthen it if we have effectively seen it before.
 * Weight is what lets a repeated observation outrank a one-off.
 */
async function upsertLesson(db, profileId, lesson, kind, niche) {
  if (!profileId) throw new Error('upsertLesson needs a profileId');
  const norm = lesson.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 90);
  const existing = await db
    .prepare(
      `SELECT id, weight FROM lessons
       WHERE profile_id = ? AND lower(substr(lesson,1,90)) LIKE ? AND kind = ?
       LIMIT 1`
    )
    .bind(profileId, `${norm.slice(0, 40)}%`, kind)
    .first();

  const ts = nowIso();
  if (existing) {
    await db
      .prepare('UPDATE lessons SET weight = weight + 1, source_count = source_count + 1, updated_at = ? WHERE id = ?')
      .bind(ts, existing.id)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO lessons (id, profile_id, lesson, kind, niche, weight, source_count, active, created_at, updated_at)
       VALUES (?,?,?,?,?,1,1,1,?,?)`
    )
    .bind(newId(), profileId, lesson, kind, niche, ts, ts)
    .run();
}

/** Active lessons, strongest first, ready to inject into a prompt. */
export async function activeLessons(db, profileId, niche = null, limit = 12) {
  if (!profileId) throw new Error('activeLessons needs a profileId');
  const { results } = await db
    .prepare(
      `SELECT lesson, kind, niche, weight FROM lessons
       WHERE profile_id = ? AND active = 1 AND (niche IS NULL OR niche = ?)
       ORDER BY weight DESC, updated_at DESC LIMIT ?`
    )
    .bind(profileId, niche, limit)
    .all();
  return results || [];
}

/** Render lessons as prompt text. Empty string when there is nothing learned. */
export function lessonsToPrompt(lessons) {
  if (!lessons?.length) return '';
  const avoid = lessons.filter((l) => l.kind === 'AVOID').map((l) => `- ${l.lesson}`);
  const prefer = lessons.filter((l) => l.kind === 'PREFER').map((l) => `- ${l.lesson}`);

  let out = '\n\nWHAT LUCIA\'S TEAM HAS LEARNED SO FAR (from real decisions on real leads — these outrank your own judgement):\n';
  if (prefer.length) out += `\nScore UP:\n${prefer.join('\n')}\n`;
  if (avoid.length) out += `\nScore DOWN:\n${avoid.join('\n')}\n`;
  return out;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * Re-score one lead in light of what the reviewer just said about it.
 *
 * Only this lead, only once. Cheap, immediate, and it means a reviewer who
 * writes "actually this one is great, the site is worse than the score
 * suggests" sees the ranking move rather than being ignored.
 */
export async function rerankOne(env, db, entityId, reason) {
  const e = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(entityId).first();
  if (!e) return { ok: false, error: 'not-found' };

  const prompt = `A reviewer looked at this prospect and gave feedback. Adjust the score to match their judgement.

BUSINESS: ${e.display_name || e.domain || 'unnamed'}
website: ${e.website || '(none)'}
current score: ${e.score}
niche: ${e.niche}
website opportunity on file: ${e.website_opportunity || 'none'}
system opportunity on file: ${e.system_opportunity || 'none'}

REVIEWER SAID: "${String(reason || '').slice(0, 500)}"

Re-estimate the score. This is a revised ESTIMATE, not a verdict:
- The reviewer declining to email them today does not mean the business is
  worthless. It may be a good lead later, or a good lead for different work.
- "Never contact them" is a separate action the reviewer takes explicitly, so
  do not express that here by scoring near zero.
- Move the score by as much as the feedback justifies and no more. A mild
  objection is a small move; "completely wrong kind of business" is a large one.

Return the revised score (${RERANK_FLOOR}-100) and one sentence explaining it.
Respond with JSON: {"score": <int>, "reason": "..."}`;

  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: { score: { type: 'integer' }, reason: { type: 'string' } },
          required: ['score', 'reason'],
        },
      },
    });
    const p = typeof res?.response === 'string' ? safeParse(res.response) : (res?.response ?? res);
    const raw = Math.round(Number(p?.score));
    if (!Number.isFinite(raw)) return { ok: false, error: 'bad-score' };

    // Floor the rerank. Left unclamped the model treats any skip as a zero —
    // an early test drove an 84 straight to 0 — which permanently buries a
    // business that may be a fine lead in six months. Suppression is the
    // explicit mechanism for never again; this is only an estimate.
    const score = Math.max(RERANK_FLOOR, Math.min(100, raw));

    await db
      .prepare(
        `UPDATE entities SET score = ?, score_reason = ?, updated_at = ? WHERE id = ?`
      )
      .bind(score, `reviewer feedback: ${String(p?.reason || reason).slice(0, 300)}`, nowIso(), entityId)
      .run();

    return { ok: true, from: e.score, to: score, reason: p?.reason };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}
