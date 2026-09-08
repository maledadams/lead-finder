// Automatic bounce detection, from a label in the mailbox.
//
// Zoho Mail has no outgoing webhook for new mail — there is no way for it to
// call this Worker when something arrives. So the label is polled on the cron
// that already runs, which for a handful of bounces a week is indistinguishable
// from a push and costs one API call per tick.
//
// A message is matched to an outreach row by finding a recipient address in it
// that belongs to a lead we actually wrote to. That is deliberately strict: a
// bounce we cannot attribute is left alone and reported, rather than guessed
// at, because marking the wrong business bounced would clear a good address.

import { labelIdByName, messagesWithLabel } from './zoho.js';
import { markBounced } from './queue.js';
import { recordFeedback } from './learning.js';

/** Everything that looks like an address, anywhere in the text. */
function addressesIn(text) {
  return [...String(text || '').matchAll(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g)]
    .map((m) => m[0].toLowerCase());
}

/**
 * Poll the bounce label and mark whatever it can attribute.
 *
 * Returns a report rather than throwing: this runs unattended on cron, and a
 * mailbox problem must never take down the crawl or the queue build.
 */
export async function syncBounces(env, db, { limit = 50 } = {}) {
  const labelName = env.ZOHO_BOUNCE_LABEL || 'bounce';
  const report = { label: labelName, scanned: 0, matched: 0, bounced: 0, unmatched: [], skipped: 0 };

  const label = await labelIdByName(env, db, labelName);
  if (!label.ok) return { ...report, error: label.error };

  const inbox = await messagesWithLabel(env, db, label.id, { limit });
  if (!inbox.ok) return { ...report, error: inbox.error };

  const messages = inbox.messages || [];
  report.scanned = messages.length;
  if (!messages.length) return report;

  // Which of these have already been handled? One query rather than one per
  // message, because this runs four times a day forever.
  const ids = messages.map((m) => String(m.messageId)).filter(Boolean);
  const seenRows = ids.length
    ? await db.prepare(
      `SELECT message_id FROM bounce_seen WHERE message_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all()
    : { results: [] };
  const seen = new Set((seenRows.results || []).map((r) => r.message_id));

  // Every address we have actually written to, and the row it belongs to.
  const { results: sent } = await db.prepare(
    `SELECT o.id AS outreach_id, o.entity_id, o.profile_id, LOWER(e.contact_email) AS email
     FROM outreach o JOIN entities e ON e.id = o.entity_id
     WHERE o.status = 'SENT' AND e.contact_email IS NOT NULL`
  ).all();
  const byAddress = new Map((sent || []).map((r) => [r.email, r]));

  for (const msg of messages) {
    const messageId = String(msg.messageId || '');
    if (!messageId || seen.has(messageId)) { report.skipped++; continue; }

    // Headers and the preview text are enough: a delivery failure notice always
    // names the address it could not reach.
    const haystack = [msg.subject, msg.summary, msg.toAddress, msg.sender].filter(Boolean).join(' ');
    const hit = addressesIn(haystack).map((a) => byAddress.get(a)).find(Boolean);

    if (!hit) {
      // Remember it anyway, so an unattributable notice is not re-examined on
      // every tick forever.
      await remember(db, messageId, null, 'unmatched');
      report.unmatched.push({ subject: String(msg.subject || '').slice(0, 80) });
      continue;
    }

    report.matched++;
    const note = `auto: ${String(msg.subject || 'bounce notice').slice(0, 150)}`;
    const res = await markBounced(db, hit.outreach_id, note);
    if (res.ok) {
      report.bounced++;
      await recordFeedback(db, {
        entityId: hit.entity_id, outreachId: hit.outreach_id,
        decision: 'BOUNCED', reason: note, reviewer: 'zoho-label', profileId: hit.profile_id,
      });
    }
    await remember(db, messageId, hit.outreach_id, res.ok ? 'bounced' : `failed: ${res.error}`);
  }

  return report;
}

function remember(db, messageId, outreachId, outcome) {
  return db.prepare(
    `INSERT INTO bounce_seen (message_id, outreach_id, outcome, seen_at) VALUES (?,?,?,?)
     ON CONFLICT(message_id) DO UPDATE SET outcome = excluded.outcome, seen_at = excluded.seen_at`
  ).bind(messageId, outreachId, outcome, new Date().toISOString()).run();
}
