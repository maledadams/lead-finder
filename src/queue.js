// The daily queue.
//
// 30 is a ceiling, never a target. If eleven businesses clear the bar today,
// the queue has eleven rows in it. There is no code path anywhere in this file
// that lowers the threshold to fill space, and there should never be one.

import { num, QUEUEABLE_STATES } from './config.js';
import { newId, nowIso } from './entity.js';
import { composeDraft } from './outreach.js';
import { deriveLessons } from './learning.js';
import { canReceiveMail } from './mx.js';

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function buildQueue(env, db, profile, { dryRun = false } = {}) {
  // Scoped explicitly rather than from an ambient current profile: a queue
  // built for the wrong one would put a dentist in front of a reviewer
  // expecting ceramics, and nothing would error.
  if (!profile?.id) throw new Error('buildQueue needs a profile');
  const profileId = profile.id;
  const runId = newId();
  const startedAt = nowIso();
  const day = todayStr();
  const max = num(env, 'DAILY_QUEUE_MAX', 30);
  const minScore = num(env, 'MIN_SCORE_TO_QUEUE', 68);

  const stats = {
    day, max, min_score: minScore,
    considered: 0, suppressed: 0, already_contacted: 0,
    no_contact_method: 0, no_honest_draft: 0, queued: 0, cooldown_days: 0,
    undeliverable: 0,
  };

  // Age out anyone who never answered, before today's list is built, so the
  // dashboard's counts are true the moment it is opened.
  if (!dryRun) {
    try {
      stats.ghosting = await sweepGhosted(db, profileId, num(env, 'GHOST_AFTER_DAYS', 30));
    } catch (err) {
      stats.ghosting = { error: String(err?.message || err).slice(0, 120) };
    }
  }

  if (!dryRun) {
    await db.prepare('INSERT INTO runs (id, profile_id, kind, started_at) VALUES (?,?,?,?)')
      .bind(runId, profileId, 'queue', startedAt).run();
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
  const cooldownDays = num(env, 'SKIP_COOLDOWN_DAYS', 45);
  const cooldownFrom = new Date(Date.now() - cooldownDays * 86400_000).toISOString();

  // A lead the reviewer just skipped must not reappear the next morning.
  //
  // Skipping moves an entity to NURTURE, which is queueable by design — the
  // point is that it may be worth revisiting. But "later" has to mean later.
  // Two businesses skipped with explicit feedback were back in the queue the
  // same day, which makes the reviewer's decision look ignored.
  const { results: candidates } = await db
    .prepare(
      `SELECT e.* FROM entities e
       WHERE e.profile_id = ?
         AND e.score IS NOT NULL
         AND e.score >= ?
         AND e.state IN (${states.map(() => '?').join(',')})
         AND e.first_contacted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM feedback f
           WHERE f.entity_id = e.id
             AND f.decision IN ('SKIPPED','BLOCKED')
             AND f.created_at > ?
         )
       ORDER BY e.score DESC, e.last_evaluated_at DESC
       LIMIT ?`
    )
    .bind(profileId, floor, ...states, cooldownFrom, max * 4)
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

    const draft = composeDraft(e, env, profile);
    if (!draft) {
      // No evidence-backed compliment, or no concrete opportunity. We do not
      // invent one. This lead simply waits for better information.
      stats.no_honest_draft++;
      continue;
    }

    // Ask DNS whether the domain can receive mail at all, before this lead is
    // ever put in front of the reviewer. Cached, so it is one lookup per new
    // domain rather than one per lead. Fails open: if DNS is unreachable the
    // lead is kept, because a network blip must not empty the morning queue.
    const mx = await canReceiveMail(db, e.contact_email);
    if (!mx.deliverable) {
      stats.undeliverable++;
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

  // Clear today's unhandled drafts before rewriting.
  //
  // Without this a rebuild appends, so ranks collide and the queue grows past
  // its own cap — an observed build produced 34 rows with two #1s and two #2s.
  // Anything already sent or skipped is left alone: that is a decision, not a
  // draft.
  await db
    .prepare("DELETE FROM outreach WHERE profile_id = ? AND queue_date = ? AND status = 'DRAFT'")
    .bind(profileId, day)
    .run();

  const ts = nowIso();
  if (selected.length) {
    await db.batch(
      selected.map((s, i) =>
        db.prepare(
          `INSERT INTO outreach
             (id, profile_id, entity_id, queue_date, rank, persona, subject, body, cta, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'DRAFT', ?)
           ON CONFLICT(entity_id, queue_date) WHERE status = 'DRAFT' DO NOTHING`
        ).bind(
          newId(), profileId, s.entity.id, day, i + 1,
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
    stats.learning = await deriveLessons(env, db, profileId);
  } catch (err) {
    stats.learning = { error: String(err?.message || err).slice(0, 120) };
  }

  await db.prepare('UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?')
    .bind(nowIso(), JSON.stringify(stats), runId).run();

  return stats;
}

/** Today's queue, joined to the entity rows, for the dashboard. */
export async function getQueue(db, profileId, day = todayStr()) {
  if (!profileId) throw new Error('getQueue needs a profileId');
  const { results } = await db
    .prepare(
      `SELECT o.id AS outreach_id, o.rank, o.subject, o.body, o.status, o.persona,
              e.id AS entity_id, e.display_name, e.website, e.domain, e.instagram,
              e.contact_email, e.score, e.score_reason, e.niche,
              e.website_opportunity, e.system_opportunity, e.power_signals,
              e.personalization, e.state
       FROM outreach o
       JOIN entities e ON e.id = o.entity_id
       WHERE o.profile_id = ? AND o.queue_date = ?
       ORDER BY o.rank ASC`
    )
    .bind(profileId, day)
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
    // skip_reason, never score_reason. The latter is the model's explanation
    // for the score and is the only record of why a lead rated as it did.
    db.prepare(
      `UPDATE entities SET state = 'NURTURE', skip_reason = ?, updated_at = ?
       WHERE id = ? AND state = 'OUTREACH_READY'`
    ).bind(String(reason).slice(0, 200), nowIso(), row.entity_id),
  ]);
  return { ok: true };
}

/**
 * The address was wrong. The business was not.
 *
 * A bounce says nothing about whether this company is worth contacting, so it
 * must not be treated as a rejection. What it does mean is that the address we
 * hold is dead, and that we must never adopt that same address again.
 *
 * Two behaviours that already exist do the rest, which is why this needs no new
 * state and no scheduler:
 *
 *   pipeline.js  contact_email = COALESCE(contact_email, ?)  -- only fills NULL
 *   queue.js:93  if (!e.contact_email) continue;             -- NULL = unqueueable
 *
 * So: null the address, park the dead one in `suppressions`, and hand the lead
 * back to NURTURE. It leaves the roster now and returns by itself once a
 * re-crawl finds a DIFFERENT address.
 *
 * Deliberately NOT routed through suppress() below: that sets DO_NOT_CONTACT,
 * which is permanent and would be exactly the wrong answer here.
 */
export async function markBounced(db, outreachId, note = 'bounced') {
  const row = await db
    .prepare(
      `SELECT o.entity_id, o.status, e.contact_email
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.id = ?`
    )
    .bind(outreachId)
    .first();
  if (!row) return { ok: false, error: 'not-found' };

  const ts = nowIso();
  const dead = row.contact_email;

  const statements = [
    db.prepare(
      "UPDATE outreach SET status = 'BOUNCED', bounced_at = ?, send_error = ? WHERE id = ?"
    ).bind(ts, `bounced: ${note}`.slice(0, 300), outreachId),
  ];

  // Belt and braces against re-adopting the same dead address: the crawler is
  // deterministic, so left alone it would very likely pick this one again.
  if (dead) {
    statements.push(
      db.prepare('INSERT OR REPLACE INTO suppressions (key, reason, created_at) VALUES (?,?,?)')
        .bind(dead, `bounced: ${note}`.slice(0, 200), ts)
    );
  }

  // The CASE guards real history. Statement 1 above has already moved THIS row
  // off 'SENT', so the subquery can only see some OTHER successful send to the
  // same business — and if one exists, this company genuinely has been
  // contacted and those timestamps must survive.
  statements.push(
    db.prepare(
      `UPDATE entities SET
         contact_email = NULL,
         contact_source = NULL,
         state = 'NURTURE',
         first_contacted_at = CASE WHEN NOT EXISTS
           (SELECT 1 FROM outreach WHERE entity_id = ? AND status = 'SENT')
           THEN NULL ELSE first_contacted_at END,
         last_contacted_at = CASE WHEN NOT EXISTS
           (SELECT 1 FROM outreach WHERE entity_id = ? AND status = 'SENT')
           THEN NULL ELSE last_contacted_at END,
         updated_at = ?
       WHERE id = ?`
    ).bind(row.entity_id, row.entity_id, ts, row.entity_id)
  );

  await db.batch(statements);
  return { ok: true, entity_id: row.entity_id, cleared: dead || null };
}

/**
 * Put a skipped or bounced draft back into today's queue so it can be edited
 * and sent.
 *
 * `idx_outreach_unique (entity_id, queue_date)` means this collides if the
 * business already has a draft today, hence OR IGNORE plus a changes check —
 * silently doing nothing would look like a broken button.
 */
export async function revive(db, outreachId) {
  const row = await db
    .prepare('SELECT entity_id, status, profile_id FROM outreach WHERE id = ?')
    .bind(outreachId)
    .first();
  if (!row) return { ok: false, error: 'not-found' };
  if (row.status === 'SENT') return { ok: false, error: 'already-sent' };

  const day = todayStr();
  const top = await db
    .prepare('SELECT COALESCE(MAX(rank), 0) AS r FROM outreach WHERE profile_id = ? AND queue_date = ?')
    .bind(row.profile_id, day)
    .first();

  const res = await db
    .prepare(
      `UPDATE OR IGNORE outreach
         SET status = 'DRAFT', queue_date = ?, rank = ?, sent_at = NULL, bounced_at = NULL
       WHERE id = ?`
    )
    .bind(day, (top?.r || 0) + 1, outreachId)
    .run();

  if (!res?.meta?.changes) {
    return { ok: false, error: 'already-queued-today' };
  }

  await db
    .prepare(
      `UPDATE entities SET state = 'OUTREACH_READY', updated_at = ?
       WHERE id = ? AND state = 'NURTURE'`
    )
    .bind(nowIso(), row.entity_id)
    .run();

  return { ok: true, queue_date: day };
}

// --- did they answer? -------------------------------------------------------
//
// `entities.response_status` has existed since the first schema and nothing
// ever wrote to it. It is the right home for this: NULL means "sent, waiting",
// and the three values below are the only answers that matter.

export const RESPONSE_STATUSES = ['REPLIED', 'NO_REPLY', 'GHOSTED'];

/**
 * Record what happened after a send.
 *
 * REPLIED also advances the funnel, because a reply is exactly what the
 * REPLIED state means. The guard keeps it from dragging a lead BACKWARDS out
 * of CONVERSATION or CLIENT, which are further along.
 */
export async function setResponseStatus(db, entityId, status) {
  const clean = status ? String(status).toUpperCase() : null;
  if (clean && !RESPONSE_STATUSES.includes(clean)) {
    return { ok: false, error: `status must be one of ${RESPONSE_STATUSES.join(', ')}, or empty` };
  }

  const row = await db.prepare('SELECT state FROM entities WHERE id = ?').bind(entityId).first();
  if (!row) return { ok: false, error: 'not-found' };

  const ts = nowIso();
  await db.prepare(
    `UPDATE entities SET response_status = ?, updated_at = ? WHERE id = ?`
  ).bind(clean, ts, entityId).run();

  // Only ever move between CONTACTED and REPLIED. Anything further along the
  // funnel is left exactly where it is.
  if (clean === 'REPLIED' && row.state === 'CONTACTED') {
    await db.prepare("UPDATE entities SET state = 'REPLIED', updated_at = ? WHERE id = ?")
      .bind(ts, entityId).run();
  } else if (clean !== 'REPLIED' && row.state === 'REPLIED') {
    await db.prepare("UPDATE entities SET state = 'CONTACTED', updated_at = ? WHERE id = ?")
      .bind(ts, entityId).run();
  }

  return { ok: true, entity_id: entityId, response_status: clean };
}

/**
 * Anyone contacted more than N days ago who never answered is ghosted.
 *
 * Only fills in a blank: a status set by hand is never overwritten, so marking
 * someone REPLIED is permanent until it is changed back. Ghosting is a label,
 * not a punishment — a ghosted lead is already out of the queue because it is
 * CONTACTED, and nothing here sends anything or blocks anything.
 */
export async function sweepGhosted(db, profileId, days = 30) {
  if (!profileId) throw new Error('sweepGhosted needs a profileId');
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const res = await db.prepare(
    `UPDATE entities SET response_status = 'GHOSTED', updated_at = ?
      WHERE profile_id = ?
        AND state = 'CONTACTED'
        AND response_status IS NULL
        AND last_contacted_at IS NOT NULL
        AND last_contacted_at < ?`
  ).bind(nowIso(), profileId, cutoff).run();

  return { ok: true, ghosted: res?.meta?.changes || 0, after_days: days, cutoff };
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
