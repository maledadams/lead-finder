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
import { recordFeedback, rerankOne } from './learning.js';
import { nowIso } from './entity.js';


const SCHEMA = {
  name: 'correction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['fact', 'opinion'] },
      display_name: { type: ['string', 'null'] },
      niche: { type: ['string', 'null'] },
      contact_email: { type: ['string', 'null'] },
      summary: { type: 'string' },
    },
    required: ['kind', 'display_name', 'niche', 'contact_email', 'summary'],
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
- kind: "fact" if the note says the RECORD IS WRONG about what this business is
  called, what it sells, or how to reach it. "opinion" if it says whether this
  business is a good lead — too corporate, not my kind of work, too big, love
  this one. An opinion is not a mistake in the data.
- If kind is "opinion", every other field MUST be null. Say nothing about the
  record; the reviewer was not correcting it.
- Otherwise return a field ONLY if the NOTE ITSELF asks for that change. The
  page text is evidence for what the note claims, never a reason of its own —
  do not tidy up a name the reviewer did not mention.
- Return null for anything you are not changing. Never invent.
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

  // An opinion changes no data, whatever the model filled in. Small models
  // volunteer tidy-ups nobody asked for — one rewrote a business name from the
  // page while the note only said "too corporate for me", which turned a
  // judgement into a correction and lost it from the ranking entirely.
  const opinion = String(parsed.kind || '').toLowerCase() === 'opinion';

  const name = String(parsed.display_name || '').trim();
  if (!opinion && name && name.length <= 120 && name !== entity.display_name) {
    // The reviewer has to have actually said it. A proposed name must share a
    // real word with the note, or it came from the page rather than from them.
    const said = new Set(clean.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    if ((name.toLowerCase().match(/[a-z0-9]{4,}/g) || []).some((w) => said.has(w))) {
      changes.display_name = name;
    } else {
      rejected.push(`name "${name}" is not something the note asked for`);
    }
  }

  const niche = String(parsed.niche || '').trim();
  if (!opinion && niche && niche !== entity.niche) {
    if (NICHES[niche]) changes.niche = niche;
    else rejected.push(`niche "${niche}" is not one of the known categories`);
  }

  const email = String(parsed.contact_email || '').trim().toLowerCase();
  if (!opinion && email && email !== entity.contact_email) {
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

  // What a note MEANS depends on whether it changed anything.
  //
  // If it corrected a fact, it is a correction: the record was wrong and is now
  // right, and the lead is re-scored as the business it actually is. That note
  // must never become a lesson — "it sells tea, not skincare" is a fact about
  // one record, and reading it as a reason to avoid tea shops would be exactly
  // backwards.
  //
  // If it changed nothing, the reviewer was not fixing data. They were telling
  // us something about whether this lead is worth having, which is precisely
  // what the ranking is built from. So it goes in as a judgement, is read by
  // deriveLessons like any skip reason, and reranks this lead immediately.
  const changed = fields.filter((f) => f !== 'updated_at' && f !== 'last_evaluated_at');
  const isCorrection = changed.length > 0;

  await recordFeedback(db, {
    entityId,
    outreachId: null,
    decision: isCorrection ? 'CORRECTED' : 'NOTE',
    reason: isCorrection && parsed.summary ? `${clean} — applied: ${parsed.summary}` : clean,
    reviewer,
  });

  // A judgement should move the score now, not at the next queue build, so the
  // reviewer sees their note land.
  let reranked = null;
  if (!isCorrection) {
    const r = await rerankOne(env, db, entityId, clean);
    if (r.ok) reranked = { from: r.from, to: r.to };
  }

  return {
    ok: true,
    changed,
    kind: isCorrection ? 'correction' : 'judgement',
    reranked,
    summary: String(parsed.summary || '').slice(0, 300),
    rejected,
  };
}
