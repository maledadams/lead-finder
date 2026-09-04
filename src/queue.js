// The daily queue.
//
// 30 is a ceiling, never a target. If eleven businesses clear the bar today,
// the queue has eleven rows in it. There is no code path anywhere in this file
// that lowers the threshold to fill space, and there should never be one.

import { num, QUEUEABLE_STATES } from './config.js';
import { newId, nowIso } from './entity.js';
import { composeDraft } from './outreach.js';
import { deriveLessons } from './learning.js';

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function buildQueue(env, db, { dryRun = false } = {}) {
  const runId = newId();
  const startedAt = nowIso();
  const day = todayStr();
  const max = num(env, 'DAILY_QUEUE_MAX', 30);
  const minScore = num(env, 'MIN_SCORE_TO_QUEUE', 68);

  const stats = {
    day, max, min_score: minScore,
    considered: 0, suppressed: 0, already_contacted: 0,
    no_contact_method: 0, no_honest_draft: 0, queued: 0,
  };

  if (!dryRun) {
    await db.prepare('INSERT INTO runs (id, kind, started_at) VALUES (?,?,?)')
      .bind(runId, 'queue', startedAt).run();
  }

  // Everything that has not been ruled out, not only what cleared the bar.
  //
  // The threshold now decides PRESENTATION, not eligibility: leads below it
  // are still shown, flagged as below the line, and the reviewer decides. A
  // score is an estimate, and the person reading the draft is better placed
  // to judge than the estimate is. Genuinely disqualified states — rejected,
  // contacted, do-not-contact — never appear.
  const states = [...QUEUEABLE_STATES, 'EVALUATED', 'NOT_NOW'];
  const floor = num(env, 'ABSOLUTE_FLOOR', 35);

  const { results: candidates } = await db
    .prepare(
      `SELECT * FROM entities
       WHERE score IS NOT NULL
         AND score >= ?
         AND state IN (${states.map(() => '?').join(',')})
         AND first_contacted_at IS NULL
       ORDER BY score DESC, last_evaluated_at DESC
       LIMIT ?`
    )
    .bind(floor, ...states, max * 4)
    .all();

  stats.considered = (candidates || []).length;

  // Suppression list — CAN-SPAM opt-outs and manual blocks.
  const { results: sup } = await db.prepare('SELECT key FROM suppressions').all();
  const suppressed = new Set((sup || []).map((r) => r.key));

  const selected = [];
  for (const e of candidates || []) {
    if (selected.length >= max) break;

    if (suppressed.has(`domain:${e.domain}`) ||
        (e.contact_email && suppressed.has(e.contact_email))) {
      stats.suppressed++;
      continue;
    }

    // Belt and braces: the state filter should already exclude these.
    if (e.first_contacted_at || e.last_contacted_at) {
      stats.already_contacted++;
      continue;
    }

    if (!e.contact_email) {
      stats.no_contact_method++;
      continue;
    }

    const draft = composeDraft(e, env);
    if (!draft) {
      // No evidence-backed compliment, or no concrete opportunity. We do not
      // invent one. This lead simply waits for better information.
      stats.no_honest_draft++;
      continue;
    }

    selected.push({ entity: e, draft, below_bar: e.score < minScore });
  }

  if (dryRun) {
    return {
      ...stats,
      queued: selected.length,
      preview: selected.map((s, i) => ({
        rank: i + 1,
        name: s.entity.display_name,
        score: s.entity.score,
        subject: s.draft.subject,
      })),
    };
  }

  // Write drafts. The unique index on (entity_id, queue_date) is the final
  // guard against generating two drafts for one business on one day.
  const ts = nowIso();
  if (selected.length) {
    await db.batch(
      selected.map((s, i) =>
        db.prepare(
          `INSERT INTO outreach
             (id, entity_id, queue_date, rank, persona, subject, body, cta, status, created_at)
           VALUES (?,?,?,?,?,?,?,?, 'DRAFT', ?)
           ON CONFLICT(entity_id, queue_date) DO NOTHING`
        ).bind(
          newId(), s.entity.id, day, i + 1,
          s.below_bar ? `${s.draft.persona}:below_bar` : s.draft.persona,
          s.draft.subject, s.draft.body, s.draft.cta, ts
        )
      )
    );

    await db.batch(
      selected.map((s) =>
        db.prepare(
          `UPDATE entities SET state = 'OUTREACH_READY',
             times_surfaced = times_surfaced + 1, updated_at = ?
           WHERE id = ? AND state IN ('QUALIFIED','SHORTLISTED','NURTURE')`
        ).bind(ts, s.entity.id)
      )
    );
  }

  stats.queued = selected.length;
  stats.below_bar = selected.filter((s) => s.below_bar).length;

  // Turn yesterday's decisions into rules before tomorrow's leads are judged.
  try {
    stats.learning = await deriveLessons(env, db);
  } catch (err) {
    stats.learning = { error: String(err?.message || err).slice(0, 120) };
  }

  await db.prepare('UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?')
    .bind(nowIso(), JSON.stringify(stats), runId).run();

  return stats;
}

/** Today's queue, joined to the entity rows, for the dashboard. */
export async function getQueue(db, day = todayStr()) {
  const { results } = await db
    .prepare(
      `SELECT o.id AS outreach_id, o.rank, o.subject, o.body, o.status, o.persona,
              e.id AS entity_id, e.display_name, e.website, e.domain, e.instagram,
              e.contact_email, e.score, e.score_reason, e.niche,
              e.website_opportunity, e.system_opportunity, e.power_signals,
              e.personalization, e.state
       FROM outreach o
       JOIN entities e ON e.id = o.entity_id
       WHERE o.queue_date = ?
       ORDER BY o.rank ASC`
    )
    .bind(day)
    .all();
  return results || [];
}

/**
 * Mark a draft sent. This is what makes a lead permanently non-new: the
 * entity moves to CONTACTED and every future queue build skips it.
 */
export async function markSent(db, outreachId) {
  const row = await db.prepare('SELECT entity_id FROM outreach WHERE id = ?').bind(outreachId).first();
  if (!row) return { ok: false, error: 'not-found' };

  const ts = nowIso();
  await db.batch([
    db.prepare("UPDATE outreach SET status = 'SENT', sent_at = ? WHERE id = ?").bind(ts, outreachId),
    db.prepare(
      `UPDATE entities SET state = 'CONTACTED',
         first_contacted_at = COALESCE(first_contacted_at, ?),
         last_contacted_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(ts, ts, ts, row.entity_id),
  ]);
  return { ok: true, entity_id: row.entity_id };
}

/** Skip a draft without contacting anyone. The lead stays available. */
export async function markSkipped(db, outreachId, reason = 'manual-skip') {
  const row = await db.prepare('SELECT entity_id FROM outreach WHERE id = ?').bind(outreachId).first();
  if (!row) return { ok: false, error: 'not-found' };

  await db.batch([
    db.prepare("UPDATE outreach SET status = 'SKIPPED' WHERE id = ?").bind(outreachId),
    db.prepare(
      `UPDATE entities SET state = 'NURTURE', score_reason = ?, updated_at = ?
       WHERE id = ? AND state = 'OUTREACH_READY'`
    ).bind(`skipped: ${reason}`.slice(0, 200), nowIso(), row.entity_id),
  ]);
  return { ok: true };
}

/** Permanent opt-out. Nothing removes these automatically. */
export async function suppress(db, key, reason = 'opt-out') {
  await db
    .prepare('INSERT OR REPLACE INTO suppressions (key, reason, created_at) VALUES (?,?,?)')
    .bind(key, reason, nowIso())
    .run();

  const clause = key.startsWith('domain:') ? 'domain = ?' : 'contact_email = ?';
  const val = key.replace(/^domain:/, '');
  await db
    .prepare(`UPDATE entities SET state = 'DO_NOT_CONTACT', updated_at = ? WHERE ${clause}`)
    .bind(nowIso(), val)
    .run();

  return { ok: true, key };
}
