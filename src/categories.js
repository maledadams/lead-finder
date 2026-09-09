// Sorting skips into your own categories.
//
// The point is a metric you can read a trend from. Raw skip reasons are only
// countable while you happen to write the same sentence twice; "Not a fit: 14"
// says something the sentences cannot.
//
// THREE RULES SHAPE THE WHOLE FILE.
//
//   Nothing is hardcoded. The categories live in the database, seeded as data.
//   This file knows that categories exist, never which ones.
//
//   Classification costs as close to nothing as it can. Keywords first, which
//   is free; one batched call for the rest; a version stamp so a reason is
//   never classified twice. Today's five skips cost one call, ever.
//
//   Editing a definition invalidates the old answers. Without that the metric
//   goes quietly stale — the bars keep moving while the meaning underneath them
//   has changed, and nothing anywhere says so.

import { AI_MODEL } from './config.js';
import { newId, nowIso } from './entity.js';

/** Skips and blocks both carry a reason, and both belong on the chart. */
const DECISIONS = ['SKIPPED', 'BLOCKED'];

export const slugify = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

export async function listCategories(db, profileId, { includeInactive = false } = {}) {
  if (!profileId) throw new Error('listCategories needs a profileId');
  const { results } = await db.prepare(
    `SELECT * FROM skip_categories
     WHERE profile_id = ?${includeInactive ? '' : ' AND active = 1'}
     ORDER BY position, name`
  ).bind(profileId).all();
  return results || [];
}

export async function categoriesVersion(db, profileId) {
  const row = await db.prepare('SELECT categories_version FROM profiles WHERE id = ?')
    .bind(profileId).first();
  return Number(row?.categories_version) || 1;
}

/**
 * Any write to a category invalidates every answer given under the old
 * definitions. Bumping the version here rather than at each call site is what
 * makes that impossible to forget.
 */
async function bumpVersion(db, profileId) {
  await db.prepare(
    'UPDATE profiles SET categories_version = categories_version + 1, updated_at = ? WHERE id = ?'
  ).bind(nowIso(), profileId).run();
}

export async function upsertCategory(db, profileId, { id, name, definition, keywords, position }) {
  if (!profileId) throw new Error('upsertCategory needs a profileId');
  const clean = String(name || '').trim().slice(0, 60);
  if (clean.length < 2) return { ok: false, error: 'give the category a name' };

  const ts = nowIso();
  const kw = String(keywords || '').split(',').map((k) => k.trim().toLowerCase())
    .filter(Boolean).slice(0, 40).join(',');
  const def = String(definition || '').trim().slice(0, 600);

  if (id) {
    const res = await db.prepare(
      `UPDATE skip_categories SET name = ?, definition = ?, keywords = ?,
              position = COALESCE(?, position), updated_at = ?
       WHERE id = ? AND profile_id = ?`
    ).bind(clean, def, kw, position ?? null, ts, id, profileId).run();
    if (!res?.meta?.changes) return { ok: false, error: 'not-found' };
    await bumpVersion(db, profileId);
    return { ok: true, id };
  }

  const slug = slugify(clean);
  if (!slug) return { ok: false, error: 'that name has no usable id in it' };
  const clash = await db.prepare(
    'SELECT id FROM skip_categories WHERE profile_id = ? AND slug = ?'
  ).bind(profileId, slug).first();
  if (clash) return { ok: false, error: `a category called "${clean}" already exists` };

  const newRow = newId();
  const next = await db.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS n FROM skip_categories WHERE profile_id = ?'
  ).bind(profileId).first();
  await db.prepare(
    `INSERT INTO skip_categories
       (id, profile_id, slug, name, definition, keywords, position, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?)`
  ).bind(newRow, profileId, slug, clean, def, kw, position ?? (next?.n || 1), ts, ts).run();
  await bumpVersion(db, profileId);
  return { ok: true, id: newRow, slug };
}

/**
 * Delete a category, never the feedback filed under it.
 *
 * The foreign key is ON DELETE SET NULL, so its skips return to unsorted and
 * are classified again on the next pass. Losing the reasons a person typed
 * because a bucket was renamed would be indefensible.
 */
export async function deleteCategory(db, profileId, id) {
  if (!profileId) throw new Error('deleteCategory needs a profileId');
  const res = await db.prepare('DELETE FROM skip_categories WHERE id = ? AND profile_id = ?')
    .bind(id, profileId).run();
  if (!res?.meta?.changes) return { ok: false, error: 'not-found' };
  await bumpVersion(db, profileId);
  return { ok: true };
}

/** A free match: the reason contains one of the category's own keywords. */
export function matchByKeyword(reason, categories) {
  const text = String(reason || '').toLowerCase();
  if (!text) return null;
  for (const c of categories) {
    for (const k of String(c.keywords || '').split(',')) {
      const kw = k.trim();
      if (kw && text.includes(kw)) return c;
    }
  }
  return null;
}

/**
 * Sort whatever is unsorted or was sorted under older definitions.
 *
 * Returns a report rather than throwing: this runs unattended inside the queue
 * build, and a model hiccup must never stop the day's leads being drafted.
 */
export async function classifyPending(env, db, profileId, { limit = 30 } = {}) {
  if (!profileId) throw new Error('classifyPending needs a profileId');
  const report = { pending: 0, by_keyword: 0, by_model: 0, unmatched: 0, calls: 0 };

  const categories = await listCategories(db, profileId);
  if (!categories.length) return { ...report, skipped: 'no-categories' };
  const version = await categoriesVersion(db, profileId);

  // The version stamp alone decides what still needs work — NOT whether a
  // category was assigned. A reason the model could not place has been
  // considered; asking about it again on every pass forever would be a call a
  // day to reach the same answer.
  const { results } = await db.prepare(
    `SELECT id, reason FROM feedback
     WHERE profile_id = ? AND decision IN (${DECISIONS.map(() => '?').join(',')})
       AND reason IS NOT NULL AND length(reason) > 3
       AND (category_version IS NULL OR category_version < ?)
     ORDER BY created_at DESC, id LIMIT ?`
  ).bind(profileId, ...DECISIONS, version, limit).all();

  const pending = results || [];
  report.pending = pending.length;
  if (!pending.length) return report;

  const writes = [];
  const unresolved = [];
  for (const row of pending) {
    const hit = matchByKeyword(row.reason, categories);
    if (hit) { writes.push([row.id, hit.id]); report.by_keyword++; }
    else unresolved.push(row);
  }

  // One call for everything the keywords could not place — not one per skip.
  if (unresolved.length) {
    const bySlug = new Map(categories.map((c) => [c.slug, c]));
    const answer = await askModel(env, unresolved, categories);
    report.calls = answer.calls;
    if (answer.error) report.error = answer.error;
    for (const [index, slug] of answer.pairs) {
      const row = unresolved[index];
      const cat = bySlug.get(slug);
      if (!row) continue;
      if (cat) { writes.push([row.id, cat.id]); report.by_model++; }
      else report.unmatched++;
    }
  }

  // Every row examined is stamped, including the ones nothing matched, or they
  // would be reconsidered on every single pass forever.
  const seen = new Set(writes.map(([id]) => id));
  const stamped = pending.filter((r) => !seen.has(r.id)).map((r) => [r.id, null]);

  if (writes.length || stamped.length) {
    const all = [...writes, ...stamped];
    for (let i = 0; i < all.length; i += 40) {
      await db.batch(all.slice(i, i + 40).map(([id, catId]) => db.prepare(
        'UPDATE feedback SET skip_category_id = ?, category_version = ? WHERE id = ?'
      ).bind(catId, version, id)));
    }
  }
  return report;
}

function prompt(rows, categories) {
  const list = categories.map((c) =>
    `  ${c.slug}: ${c.name} — ${c.definition || 'no definition given'}`).join('\n');
  // Reasons are truncated hard. The whole prompt is a list of short sentences
  // and a list of buckets, which is what keeps this call small.
  const items = rows.map((r, i) => `${i}: ${String(r.reason).slice(0, 200)}`).join('\n');
  return `Sort each reason for skipping a sales lead into one of these categories.

CATEGORIES
${list}

REASONS
${items}

Answer with one entry per reason, using its number and the category id. If a
reason fits none of them, use "none" rather than forcing it.`;
}

async function askModel(env, rows, categories) {
  const slugs = categories.map((c) => c.slug);
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'You file short notes into fixed categories. You never invent a category.' },
        { role: 'user', content: prompt(rows, categories) },
      ],
      max_tokens: 40 + rows.length * 14,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            answers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  i: { type: 'integer' },
                  category: { type: 'string', enum: [...slugs, 'none'] },
                },
                required: ['i', 'category'],
              },
            },
          },
          required: ['answers'],
        },
      },
    });
    const raw = res?.response ?? res;
    const parsed = typeof raw === 'object' ? raw
      : JSON.parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1));
    const pairs = (Array.isArray(parsed?.answers) ? parsed.answers : [])
      .map((a) => [Number(a?.i), String(a?.category || '')])
      .filter(([i]) => Number.isInteger(i) && i >= 0 && i < rows.length);
    return { pairs, calls: 1 };
  } catch (err) {
    return { pairs: [], calls: 1, error: String(err?.message || err).slice(0, 160) };
  }
}

/**
 * The chart: the busiest categories, and one honest bucket for the rest.
 *
 * Showing only the top few without saying what they leave out would understate
 * the total, which on a page whose whole job is counting is worse than useless.
 */
export async function categoryCounts(db, profileId, from, to, { top = 4 } = {}) {
  if (!profileId) throw new Error('categoryCounts needs a profileId');
  const { results } = await db.prepare(
    `SELECT COALESCE(c.name, 'Not yet sorted') AS label, COUNT(*) AS n
     FROM feedback f LEFT JOIN skip_categories c ON c.id = f.skip_category_id
     WHERE f.profile_id = ? AND f.decision IN (${DECISIONS.map(() => '?').join(',')})
       AND f.reason IS NOT NULL
       AND substr(f.created_at,1,10) >= ? AND substr(f.created_at,1,10) < ?
     GROUP BY label ORDER BY n DESC`
  ).bind(profileId, ...DECISIONS, from, to).all();

  const rows = results || [];
  if (rows.length <= top + 1) return rows;
  const head = rows.slice(0, top);
  const rest = rows.slice(top).reduce((n, r) => n + Number(r.n), 0);
  return rest ? [...head, { label: 'Other', n: rest }] : head;
}
