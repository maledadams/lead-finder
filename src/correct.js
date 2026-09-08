// Correcting the system, rather than editing a row.
//
// A directory record and a website can disagree — OpenStreetMap listed
// "Glasshaus Gardens" with a website tag pointing at fettlebotanic.com, so the
// name, the niche and the draft were all about the wrong business while the
// page itself was read correctly.
//
// The reviewer is the one who can see that in a second. Rather than making them
// hand-edit three fields, they say what is wrong in a sentence and the model
// works out which fields that implies, using the page text as evidence. The
// The record is corrected and its score is cleared, so it is judged again as
// the business it actually is — that is the self-correction. The note is kept
// as an audit trail rather than as a lesson, because a fact about a record is
// not a judgement about which leads are worth having.
//
// What the model may change is deliberately narrow: the name, the niche and the
// address. It cannot touch the score, the state or anything that decides
// whether a lead is contacted — a correction fixes facts, it does not promote.

import { AI_MODEL, NICHES } from './config.js';
import { canReceiveMail } from './mx.js';
import { isUsableEmail } from './extract.js';
import { recordFeedback } from './learning.js';
import { nowIso } from './entity.js';


const SCHEMA = {
  name: 'correction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      display_name: { type: ['string', 'null'] },
      niche: { type: ['string', 'null'] },
      contact_email: { type: ['string', 'null'] },
      summary: { type: 'string' },
    },
    required: ['display_name', 'niche', 'contact_email', 'summary'],
    additionalProperties: false,
  },
};

function buildPrompt(entity, note, pageText) {
  const slugs = Object.keys(NICHES);
  return `A reviewer is correcting a record. Apply ONLY what their note supports.

THE RECORD AS IT STANDS
  name:    ${entity.display_name || '(none)'}
  website: ${entity.website || entity.domain || '(none)'}
  niche:   ${entity.niche || '(none)'}
  email:   ${entity.contact_email || '(none)'}

WHAT THE PAGE ITSELF SAYS
${String(pageText || '(no page text on file)').slice(0, 1500)}

THE REVIEWER'S NOTE
${note}

RULES
- Return a field ONLY if the note or the page clearly implies a new value for
  it. Return null for anything you are not changing. Never invent.
- niche must be exactly one of: ${slugs.join(', ')} — or null.
- contact_email must appear in the note or the page text. Never guess one.
- summary: one short sentence saying what you changed and why.`;
}

export async function applyCorrection(env, db, entityId, note, { reviewer = 'dashboard' } = {}) {
  const clean = String(note || '').trim();
  if (clean.length < 4) return { ok: false, error: 'say what is wrong' };

  const entity = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(entityId).first();
  if (!entity) return { ok: false, error: 'not-found' };

  const snap = await db.prepare(
    'SELECT text_sample FROM snapshots WHERE entity_id = ? ORDER BY fetched_at DESC LIMIT 1'
  ).bind(entityId).first();

  let parsed;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'You correct business records. You are terse and you never invent facts.' },
        { role: 'user', content: buildPrompt(entity, clean, snap?.text_sample) },
      ],
      max_tokens: 400,
      temperature: 0.1,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    });
    const raw = res?.response ?? res;
    parsed = typeof raw === 'object' ? raw : JSON.parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1));
  } catch (err) {
    return { ok: false, error: `model: ${String(err?.message || err).slice(0, 120)}` };
  }
  if (!parsed) return { ok: false, error: 'unparseable-model-output' };

  // Everything the model proposes is checked here. A model that hallucinates a
  // niche or an address must not be able to write one.
  const changes = {};
  const rejected = [];

  const name = String(parsed.display_name || '').trim();
  if (name && name.length <= 120 && name !== entity.display_name) changes.display_name = name;

  const niche = String(parsed.niche || '').trim();
  if (niche && niche !== entity.niche) {
    if (NICHES[niche]) changes.niche = niche;
    else rejected.push(`niche "${niche}" is not one of the known categories`);
  }

  const email = String(parsed.contact_email || '').trim().toLowerCase();
  if (email && email !== entity.contact_email) {
    if (!isUsableEmail(email)) {
      rejected.push(`address "${email}" is not a usable address`);
    } else {
      const blocked = await db.prepare('SELECT reason FROM suppressions WHERE key = ?').bind(email).first();
      if (blocked) rejected.push(`address "${email}" is suppressed (${blocked.reason})`);
      else {
        const reach = await canReceiveMail(db, email);
        if (!reach.deliverable) rejected.push(`address "${email}" cannot receive mail (${reach.detail})`);
        else changes.contact_email = email;
      }
    }
  }

  const fields = Object.keys(changes);
  if (fields.length) {
    changes.updated_at = nowIso();
    // Re-evaluating is the honest response to being told the record was wrong:
    // the old score was formed about the wrong business.
    if (changes.niche || changes.display_name) changes.last_evaluated_at = null;
    const cols = Object.keys(changes);
    await db.prepare(
      `UPDATE entities SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
    ).bind(...cols.map((c) => changes[c]), entityId).run();
  }

  // Recorded whether or not anything changed, as an audit trail of what was
  // corrected and by whom. Deliberately NOT fed to deriveLessons: "it sells tea,
  // not skincare" is a fact about the record, and reading it as a reason to
  // avoid tea shops would be exactly wrong. The lead is re-scored instead.
  await recordFeedback(db, {
    entityId, outreachId: null, decision: 'CORRECTED',
    reason: `${clean}${parsed.summary ? ` — applied: ${parsed.summary}` : ''}`,
    reviewer,
  });

  return {
    ok: true,
    changed: fields.filter((f) => f !== 'updated_at' && f !== 'last_evaluated_at'),
    summary: String(parsed.summary || '').slice(0, 300),
    rejected,
  };
}
