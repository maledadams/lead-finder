// Profiles: separate outreach operations sharing one deployment.
//
// Switching profile should feel like switching account. Leads, drafts, replies,
// lessons, keywords, frontier, spend and every metric belong to exactly one
// profile. The plumbing is shared: one mailbox, one Cloudflare account, one
// database, one booking calendar, one send cap.
//
// TWO THINGS ARE SHARED ON PURPOSE, and both would be wrong to split.
//
//   Dedup. entity_keys is unique across the whole database, so a business
//   belongs to whichever profile discovered it first and every other profile
//   skips it. Splitting that would let one person receive two different pitches
//   from the same sender, which is the worst thing this system could do to a
//   sending reputation.
//
//   The send cap. One mailbox has one reputation. Two profiles sending thirty
//   each is sixty cold emails a day from one address, and if that reputation
//   goes, both profiles stop landing.
//
// Configuration lives as JSON on the profile row rather than as constants,
// because it is the part that differs. Anything a profile has not defined falls
// back to the built-in creative defaults, so the original profile keeps working
// untouched and a new profile only has to specify what makes it different.

import { NICHES as DEFAULT_NICHES, AI_MODEL } from './config.js';
import { METROS as DEFAULT_METROS } from './osm.js';
import { PERSONAS as DEFAULT_PERSONAS } from './outreach.js';
import { newId, nowIso } from './entity.js';
import { seedDefaultCategories } from './categories.js';

export const DEFAULT_PROFILE_ID = 'p-creative';

const json = (v, fallback) => {
  if (!v) return fallback;
  try {
    const parsed = JSON.parse(v);
    return parsed && (Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length)
      ? parsed : fallback;
  } catch { return fallback; }
};

/** Every profile, default first. */
export async function listProfiles(db) {
  const { results } = await db.prepare(
    `SELECT id, slug, name, active, is_default FROM profiles
     WHERE active = 1 ORDER BY is_default DESC, name`
  ).all();
  return results || [];
}

/**
 * The profile a request is operating on.
 *
 * A slug wins when it names a real one, otherwise the default. Never returns
 * null: every query in the system is scoped by this, so a missing profile has
 * to fail loudly here rather than quietly widening a query to everything.
 */
export async function resolveProfile(db, slug = null) {
  if (slug) {
    const hit = await db.prepare(
      'SELECT * FROM profiles WHERE slug = ? AND active = 1'
    ).bind(String(slug)).first();
    if (hit) return withConfig(hit);
  }
  const def = await db.prepare(
    'SELECT * FROM profiles WHERE active = 1 ORDER BY is_default DESC, created_at LIMIT 1'
  ).first();
  if (!def) throw new Error('no active profile — run migration 008');
  return withConfig(def);
}

export async function profileById(db, id) {
  const row = await db.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first();
  return row ? withConfig(row) : null;
}

/**
 * A profile row plus its resolved configuration.
 *
 * Anything unset falls back to the built-in creative defaults, which is what
 * lets the original profile carry on with no stored config at all.
 */
export function withConfig(row) {
  return {
    ...row,
    niches: json(row.niches, DEFAULT_NICHES),
    personas: json(row.personas, DEFAULT_PERSONAS),
    seedKeywords: json(row.seed_keywords, null),
    metros: json(row.metros, DEFAULT_METROS),
    budgets: json(row.budgets, null),
    discovery: json(row.discovery, null),
    aiSystem: row.ai_system || null,
  };
}

// ---------------------------------------------------------------------------
// Creating one
// ---------------------------------------------------------------------------

const SCHEMA = {
  name: 'profile_config',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      ai_system: { type: 'string' },
      niches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            label: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
            persona_context: { type: 'string' },
            subject: { type: 'string' },
            osm: {
              type: 'object',
              properties: {
                amenity: { type: 'array', items: { type: 'string' } },
                healthcare: { type: 'array', items: { type: 'string' } },
                craft: { type: 'array', items: { type: 'string' } },
                shop: { type: 'array', items: { type: 'string' } },
                office: { type: 'array', items: { type: 'string' } },
              },
              required: ['amenity', 'healthcare', 'craft', 'shop', 'office'],
              additionalProperties: false,
            },
          },
          required: ['slug', 'label', 'keywords', 'persona_context', 'subject', 'osm'],
          additionalProperties: false,
        },
      },
      seed_keywords: { type: 'array', items: { type: 'string' } },
    },
    required: ['ai_system', 'niches', 'seed_keywords'],
    additionalProperties: false,
  },
};

function prompt(name, brief) {
  return `Configure a cold-outreach profile for a freelance web developer who builds
custom coded websites and internal systems — never Shopify, Wix or a site builder.

PROFILE NAME: ${name}
WHAT THEY WANT TO REACH:
${brief}

Produce configuration for finding and writing to these businesses in the United States.

ai_system: the brief a scoring model is judged against. Say who is a good fit,
who is not, and what disqualifies a business outright. Write it as instructions,
in the second person, 120 words or fewer.

niches: between two and six categories these businesses fall into. For each:
  slug         lower_snake_case
  label        how a person would say it
  keywords     15-40 terms found on such a business's own website. These decide
               which category a crawled site belongs to.
  persona_context  one sentence the sender uses to say what they do FOR THIS
               kind of business. First person, plain, no salesmanship. It
               follows "I'm <name>." in the email.
  subject      an email subject line with {name} where the business name goes.

  osm          OpenStreetMap tag values that identify THIS category on the map.
               Real OSM values only, lower_snake_case, and an empty array for
               any field where nothing fits. amenity (eg dentist, doctors,
               clinic, veterinary), healthcare (eg physiotherapist, dentist,
               podiatrist), craft (eg plumber, electrician, hvac, carpenter,
               roofer), shop (eg car_repair, funeral_directors), office (eg
               logistics, courier, estate_agent). These are how a business found
               on the map is filed under this category, so do not repeat the same
               value under two categories.

seed_keywords: 20-40 search terms for finding these businesses. Concrete trade
and specialty terms, not adjectives.`;
}

/**
 * Generate a profile from a sentence describing who to reach.
 *
 * The model writes the configuration; this validates every part of it before a
 * row exists. A profile with an invented OSM tag or a missing persona would
 * fail silently at crawl time, days later, which is the worst place to find out.
 */
export async function createProfile(env, db, { name, brief, slug = null }) {
  const cleanName = String(name || '').trim().slice(0, 80);
  const cleanBrief = String(brief || '').trim();
  if (cleanName.length < 2) return { ok: false, error: 'give the profile a name' };
  if (cleanBrief.length < 40) {
    return { ok: false, error: 'describe who you want to reach in a sentence or two' };
  }

  const wanted = (slug || cleanName).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 40);
  if (!wanted) return { ok: false, error: 'that name has no usable slug in it' };
  const clash = await db.prepare('SELECT id FROM profiles WHERE slug = ?').bind(wanted).first();
  if (clash) return { ok: false, error: `a profile called "${wanted}" already exists` };

  let cfg;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'You configure lead-generation systems. You are concrete and you never invent OpenStreetMap tags.' },
        { role: 'user', content: prompt(cleanName, cleanBrief) },
      ],
      max_tokens: 2200,
      temperature: 0.3,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    });
    const raw = res?.response ?? res;
    cfg = typeof raw === 'object' ? raw
      : JSON.parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1));
  } catch (err) {
    return { ok: false, error: `model: ${String(err?.message || err).slice(0, 140)}` };
  }

  const problems = [];
  const niches = {};
  const personas = {};
  for (const n of Array.isArray(cfg?.niches) ? cfg.niches : []) {
    const s = String(n?.slug || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    const kw = (Array.isArray(n?.keywords) ? n.keywords : [])
      .map((k) => String(k).toLowerCase().trim()).filter((k) => k.length > 2);
    if (!s || !n?.label || kw.length < 5) { problems.push(`niche "${n?.slug}" is too thin`); continue; }
    // OSM tags live on the niche that claimed them: that is how a business
    // found on the map is filed, so they cannot be a single flat list.
    const osm = {};
    for (const field of ['amenity', 'healthcare', 'craft', 'shop', 'office']) {
      osm[field] = [...new Set((Array.isArray(n?.osm?.[field]) ? n.osm[field] : [])
        // OSM values are lower_snake_case; anything else is invented.
        .map((v) => String(v).toLowerCase().trim().replace(/[^a-z0-9_]/g, ''))
        .filter(Boolean))].slice(0, 24);
    }
    niches[s] = {
      label: String(n.label).slice(0, 60),
      keywords: [...new Set(kw)].slice(0, 60),
      osm,
    };
    personas[s] = {
      label: String(n.label).slice(0, 60),
      context: String(n.persona_context || '').slice(0, 300),
      subject: String(n.subject || '{name} — a few notes on your site').slice(0, 120),
    };
  }
  if (!Object.keys(niches).length) {
    return { ok: false, error: `the model produced no usable categories (${problems.join('; ') || 'none returned'})` };
  }

  const seeds = [...new Set((Array.isArray(cfg?.seed_keywords) ? cfg.seed_keywords : [])
    .map((k) => String(k).toLowerCase().trim()).filter((k) => k.length > 2))].slice(0, 60);

  // Discovery has to be possible by at least one route, or the profile would be
  // created and then quietly find nothing for days.
  const osmTags = Object.values(niches).flatMap((n) => Object.values(n.osm).flat());
  if (!osmTags.length && !seeds.length) {
    return { ok: false, error: 'no way to discover these businesses was produced — try a more concrete brief' };
  }

  const id = `p-${wanted}`;
  const ts = nowIso();
  await db.prepare(
    `INSERT INTO profiles
       (id, slug, name, active, is_default, brief, ai_system, niches, personas,
        seed_keywords, metros, budgets, discovery, created_at, updated_at)
     VALUES (?,?,?,1,0,?,?,?,?,?,NULL,NULL,?,?,?)`
  ).bind(
    id, wanted, cleanName, cleanBrief,
    String(cfg.ai_system || '').slice(0, 1600) || null,
    JSON.stringify(niches), JSON.stringify(personas), JSON.stringify(seeds),
    JSON.stringify({ osm_tags: osmTags.length }), ts, ts
  ).run();

  // The starter skip categories, so the new profile's metrics are not blank and
  // the feature is not something to go looking for. They are ordinary rows.
  await seedDefaultCategories(db, id);

  // Discovery starts from these. Seeded here rather than on first crawl so the
  // profile is not silently empty until the next cron tick.
  if (seeds.length) {
    await db.batch(seeds.map((k) => db.prepare(
      `INSERT OR IGNORE INTO keywords (profile_id, keyword, niche, source, status, added_at)
       VALUES (?,?,NULL,'profile-seed','UNVALIDATED',?)`
    ).bind(id, k, ts)));
  }

  return {
    ok: true,
    id,
    slug: wanted,
    niches: Object.keys(niches),
    seed_keywords: seeds.length,
    osm_tags: Object.fromEntries(
      Object.entries(niches).map(([slug, n]) => [
        slug, Object.entries(n.osm).filter(([, v]) => v.length).map(([f, v]) => `${f}=${v.join('|')}`),
      ]).filter(([, v]) => v.length)
    ),
    warnings: problems,
  };
}

export async function setDefaultProfile(db, id) {
  const row = await db.prepare('SELECT id FROM profiles WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: 'not-found' };
  await db.batch([
    db.prepare('UPDATE profiles SET is_default = 0'),
    db.prepare('UPDATE profiles SET is_default = 1, updated_at = ? WHERE id = ?').bind(nowIso(), id),
  ]);
  return { ok: true };
}

/**
 * What deleting this profile would destroy, counted before anything is touched.
 *
 * The confirmation says these numbers out loud. "Delete profile?" is a question
 * nobody can answer well; "this deletes 1,958 leads and 157 sent emails" is.
 */
export async function profileFootprint(db, id) {
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM entities WHERE profile_id = ?1) AS leads,
       (SELECT COUNT(*) FROM outreach WHERE profile_id = ?1 AND status = 'SENT') AS sent,
       (SELECT COUNT(*) FROM outreach WHERE profile_id = ?1) AS drafts,
       (SELECT COUNT(*) FROM feedback WHERE profile_id = ?1) AS decisions,
       (SELECT COUNT(*) FROM lessons  WHERE profile_id = ?1) AS lessons`
  ).bind(id).first();
  return {
    leads: row?.leads || 0,
    sent: row?.sent || 0,
    drafts: row?.drafts || 0,
    decisions: row?.decisions || 0,
    lessons: row?.lessons || 0,
  };
}

/**
 * Stop a profile without destroying it.
 *
 * This is the button that should almost always be pressed instead of delete: it
 * disappears from the switcher and from the crawl, and nothing is lost. The
 * only irreversible thing here should be the one that says it is.
 */
export async function archiveProfile(db, id, { active = false } = {}) {
  const others = await db.prepare(
    'SELECT COUNT(*) AS n FROM profiles WHERE active = 1 AND id <> ?'
  ).bind(id).first();
  if (!active && !(others?.n)) {
    return { ok: false, error: 'this is the only active profile — there would be nowhere to work' };
  }

  const res = await db.prepare('UPDATE profiles SET active = ?, updated_at = ? WHERE id = ?')
    .bind(active ? 1 : 0, nowIso(), id).run();
  if (!res?.meta?.changes) return { ok: false, error: 'not-found' };

  // An archived profile must not stay the default, or the next visit resolves
  // to something that is no longer running.
  if (!active) {
    const wasDefault = await db.prepare('SELECT is_default FROM profiles WHERE id = ?').bind(id).first();
    if (wasDefault?.is_default) {
      const heir = await db.prepare(
        'SELECT id FROM profiles WHERE active = 1 AND id <> ? ORDER BY created_at LIMIT 1'
      ).bind(id).first();
      if (heir) await setDefaultProfile(db, heir.id);
    }
  }
  return { ok: true, active: Boolean(active) };
}

/**
 * Delete a profile and everything that belongs to it. There is no undo.
 *
 * TWO THINGS MATTER HERE beyond the obvious.
 *
 * The order is explicit rather than left to ON DELETE CASCADE. The cascade
 * would probably do the right thing; "probably" is not a word that belongs
 * anywhere near the only irreversible operation in the system.
 *
 * entity_keys is released deliberately. Those rows are globally unique and are
 * what stops two profiles pitching the same business. Leave them behind and
 * every business this profile ever found becomes permanently undiscoverable by
 * every other profile — the database would keep enforcing a claim on behalf of
 * something that no longer exists.
 */
export async function deleteProfile(db, id, { confirmName = null } = {}) {
  const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first();
  if (!profile) return { ok: false, error: 'not-found' };

  if (confirmName !== null && String(confirmName).trim() !== profile.name) {
    return { ok: false, error: 'the name did not match — nothing was deleted' };
  }

  const others = await db.prepare(
    'SELECT COUNT(*) AS n FROM profiles WHERE id <> ?'
  ).bind(id).first();
  if (!others?.n) return { ok: false, error: 'this is the only profile — deleting it leaves nothing' };

  const footprint = await profileFootprint(db, id);
  const sub = 'SELECT id FROM entities WHERE profile_id = ?';

  // Children of entities first, then the entities, then everything scoped
  // directly to the profile, then the profile itself.
  const steps = [
    `DELETE FROM entity_keys  WHERE entity_id IN (${sub})`,
    `DELETE FROM snapshots    WHERE entity_id IN (${sub})`,
    `DELETE FROM evaluations  WHERE entity_id IN (${sub})`,
    `DELETE FROM feedback     WHERE entity_id IN (${sub})`,
    `DELETE FROM outreach     WHERE entity_id IN (${sub})`,
    'DELETE FROM entities        WHERE profile_id = ?',
    'DELETE FROM crawl_frontier  WHERE profile_id = ?',
    'DELETE FROM keywords        WHERE profile_id = ?',
    'DELETE FROM source_cursor   WHERE profile_id = ?',
    'DELETE FROM budget          WHERE profile_id = ?',
    'DELETE FROM lessons         WHERE profile_id = ?',
    'DELETE FROM runs            WHERE profile_id = ?',
    'DELETE FROM feedback        WHERE profile_id = ?',
    'DELETE FROM outreach        WHERE profile_id = ?',
    'DELETE FROM skip_categories WHERE profile_id = ?',
    'DELETE FROM regions         WHERE profile_id = ?',
    'DELETE FROM profiles        WHERE id = ?',
  ];
  await db.batch(steps.map((sql) => db.prepare(sql).bind(id)));

  // Something has to be the default afterwards.
  const stillDefault = await db.prepare(
    'SELECT COUNT(*) AS n FROM profiles WHERE is_default = 1 AND active = 1'
  ).first();
  if (!stillDefault?.n) {
    const heir = await db.prepare(
      'SELECT id FROM profiles WHERE active = 1 ORDER BY created_at LIMIT 1'
    ).first();
    if (heir) await setDefaultProfile(db, heir.id);
  }

  return { ok: true, deleted: profile.name, ...footprint };
}

/** Rename, and adjust the per-profile crawl allowance. */
export async function updateProfile(db, id, { name, budgets }) {
  const sets = [];
  const args = [];
  if (name !== undefined) {
    const clean = String(name || '').trim().slice(0, 80);
    if (clean.length < 2) return { ok: false, error: 'give the profile a name' };
    sets.push('name = ?');
    args.push(clean);
  }
  if (budgets !== undefined) {
    const out = {};
    for (const k of ['fetch', 'ai', 'source', 'browser']) {
      const v = Number(budgets?.[k]);
      if (Number.isFinite(v) && v >= 0) out[k] = Math.min(Math.round(v), 100000);
    }
    sets.push('budgets = ?');
    args.push(Object.keys(out).length ? JSON.stringify(out) : null);
  }
  if (!sets.length) return { ok: false, error: 'nothing to change' };

  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  const res = await db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args).run();
  return res?.meta?.changes ? { ok: true } : { ok: false, error: 'not-found' };
}

/** Per-profile daily crawl allowance, falling back to the deployment default. */
export function budgetsFor(profile, env) {
  const b = profile?.budgets || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    fetch: num(b.fetch, num(env?.DAILY_FETCH_BUDGET, 900)),
    ai: num(b.ai, num(env?.DAILY_AI_BUDGET, 75)),
    source: num(b.source, num(env?.DAILY_SOURCE_QUERIES, 24)),
    browser: num(b.browser, num(env?.DAILY_BROWSER_RENDERS, 30)),
  };
}
