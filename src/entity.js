// Entity resolution. The rule the whole system rests on: the same business
// must never enter the pipeline twice, no matter which door it came through.
//
// Approach: every identifier we ever see becomes a key row pointing at an
// entity. A new candidate is resolved by looking up all of its keys at once.
// Any hit means we already know this business. Two hits pointing at different
// entities means we just learned they were the same business all along, so we
// merge them.

import { MARKETPLACE_HOSTS } from './config.js';

const LEGAL_SUFFIXES =
  /\b(llc|l\.l\.c\.|inc|inc\.|incorporated|co|co\.|corp|corp\.|ltd|ltd\.|limited|gmbh|studio|shop|store|the)\b/g;

// Multi-part public suffixes we actually hit. Not a full PSL — that would be
// megabytes — but enough to keep `brand.co.uk` from collapsing to `co.uk`.
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'co.jp', 'com.br', 'com.mx', 'co.za', 'com.tr', 'com.sg', 'co.kr',
]);

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

/** Strip a URL down to its registrable domain. Returns null if unusable. */
export function normalizeDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;

  let host;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  if (!host || !host.includes('.')) return null;

  host = host.replace(/^www\./, '');

  const parts = host.split('.');
  if (parts.length > 2) {
    const lastTwo = parts.slice(-2).join('.');
    const keep = MULTI_PART_TLDS.has(lastTwo) ? 3 : 2;
    host = parts.slice(-keep).join('.');
  }
  return host;
}

/** Canonical https:// URL for a page, minus tracking params and fragments. */
export function normalizeUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';

  for (const p of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref|source|_ga)/i.test(p)) u.searchParams.delete(p);
  }
  // Collapse "/" and "" to a single canonical form.
  if (u.pathname === '/') u.pathname = '';
  else u.pathname = u.pathname.replace(/\/+$/, '');

  return u.toString();
}

function handleFrom(input, host) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  // Bare handle, with or without @.
  if (!s.includes('/') && !s.includes('.')) return s.replace(/^@/, '') || null;

  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : 'https://' + s);
    if (host && !u.hostname.replace(/^www\./, '').endsWith(host)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    return seg[0].replace(/^@/, '') || null;
  } catch {
    return null;
  }
}

export const normalizeInstagram = (v) => handleFrom(v, 'instagram.com');
export const normalizeTiktok = (v) => handleFrom(v, 'tiktok.com');

export function normalizeEtsy(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  const m = s.match(/etsy\.com\/(?:[a-z-]+\/)?shop\/([a-z0-9_-]+)/i);
  if (m) return m[1].toLowerCase();
  if (!s.includes('/') && !s.includes('.')) return s.replace(/^@/, '') || null;
  return null;
}

export function normalizeEmail(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

export function normalizeName(input) {
  if (!input) return null;
  const s = String(input)
    .toLowerCase()
    .replace(/[''’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 3 ? s : null;
}

// Generic tails brands bolt onto a handle but not a domain, or the reverse.
// Only genuinely contentless words belong here — "brand" and "label" do not,
// because they are usually part of the actual name.
const HANDLE_TAILS = /(?:co|shop|store|official|hq|thelabel|nyc|usa)$/;

const MIN_SLUG = 5;

/**
 * Comparison slugs for an identifier: the full alphanumeric form, plus a
 * tail-stripped variant when one exists.
 *
 * Emitting both variants rather than only the stripped one matters. Stripping
 * alone would turn "cutebrand" into "cute" (because "brand" looks like a
 * tail), which is both wrong and dangerously generic. With variants,
 * "cute-brand.com" yields ["cutebrand"] and "@cutebrandco" yields
 * ["cutebrandco", "cutebrand"] — they meet on "cutebrand" and nothing
 * over-collapses.
 */
export function slugVariants(identifier) {
  if (!identifier) return [];
  const full = String(identifier).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (full.length < MIN_SLUG) return [];

  const out = [full];
  const stripped = full.replace(HANDLE_TAILS, '');
  if (stripped !== full && stripped.length >= MIN_SLUG) out.push(stripped);
  return out;
}

/**
 * Build the dedup keys for a candidate, in two tiers.
 *
 * STRONG keys are exact identifiers — an exact match is proof of the same
 * business and merges unconditionally.
 *
 * WEAK keys are similarity hints. A weak match alone is not proof, so it only
 * merges when nothing contradicts it (see `conflicts` in resolveEntity). This
 * is the difference between correctly folding `cute-brand.com` into
 * `@cutebrandco`, and wrongly folding two unrelated brands both called
 * "moon studio" into one lead.
 */
export function identityKeys(c) {
  const strong = [];
  const weak = [];
  const domain = normalizeDomain(c.website || c.domain);
  const ig = normalizeInstagram(c.instagram);
  const tt = normalizeTiktok(c.tiktok);
  const etsy = normalizeEtsy(c.etsy);
  const email = normalizeEmail(c.contact_email);

  if (domain && !MARKETPLACE_HOSTS.has(domain)) strong.push({ kind: 'domain', key: `domain:${domain}` });
  if (ig) strong.push({ kind: 'instagram', key: `instagram:${ig}` });
  if (tt) strong.push({ kind: 'tiktok', key: `tiktok:${tt}` });
  if (etsy) strong.push({ kind: 'etsy', key: `etsy:${etsy}` });
  if (email) strong.push({ kind: 'email', key: `email:${email}` });

  // Slug variants from every identifier we have, deduplicated.
  const slugs = new Set();
  for (const src of [domain ? domain.split('.')[0] : null, ig, tt, etsy]) {
    for (const v of slugVariants(src)) slugs.add(v);
  }
  for (const s of slugs) weak.push({ kind: 'slug', key: `slug:${s}` });

  const name = normalizeName(c.display_name);
  if (name && !strong.length) weak.push({ kind: 'name', key: `name:${name}` });

  return {
    keys: [...strong, ...weak], strong, weak,
    domain, ig, tt, etsy, email, name, slugs: [...slugs],
  };
}

/** Look up every key in one query. Returns Map<key, entity_id>. */
async function lookupKeys(db, keys) {
  if (!keys.length) return new Map();
  const placeholders = keys.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT key, entity_id FROM entity_keys WHERE key IN (${placeholders})`)
    .bind(...keys.map((k) => k.key))
    .all();
  return new Map((results || []).map((r) => [r.key, r.entity_id]));
}

/**
 * Fold `loserId` into `winnerId`: repoint keys, move child rows, copy across
 * any field the winner is missing, delete the loser.
 */
export async function mergeEntities(db, winnerId, loserId) {
  if (winnerId === loserId) return;

  const winner = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(winnerId).first();
  const loser = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(loserId).first();
  if (!winner || !loser) return;

  const fillable = [
    'display_name', 'founder_name', 'website', 'domain', 'instagram', 'tiktok',
    'etsy', 'niche', 'location_text', 'country', 'contact_email',
    'contact_source', 'phone', 'osm_tags', 'has_website',
    'website_opportunity', 'system_opportunity',
    'power_signals', 'creative_signals', 'personalization', 'outreach_angle',
    'discovery_source',
  ];
  const patch = {};
  for (const f of fillable) if (!winner[f] && loser[f]) patch[f] = loser[f];

  // Preserve the earliest discovery and the strongest contact history.
  if (loser.first_seen_at && loser.first_seen_at < winner.first_seen_at) {
    patch.first_seen_at = loser.first_seen_at;
  }
  if (loser.first_contacted_at &&
      (!winner.first_contacted_at || loser.first_contacted_at < winner.first_contacted_at)) {
    patch.first_contacted_at = loser.first_contacted_at;
  }
  if (loser.last_contacted_at &&
      (!winner.last_contacted_at || loser.last_contacted_at > winner.last_contacted_at)) {
    patch.last_contacted_at = loser.last_contacted_at;
  }

  const stmts = [];
  if (Object.keys(patch).length) {
    const cols = Object.keys(patch);
    stmts.push(
      db.prepare(
        `UPDATE entities SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
      ).bind(...cols.map((c) => patch[c]), nowIso(), winnerId)
    );
  }

  stmts.push(db.prepare('UPDATE entity_keys SET entity_id = ? WHERE entity_id = ?').bind(winnerId, loserId));
  stmts.push(db.prepare('UPDATE snapshots  SET entity_id = ? WHERE entity_id = ?').bind(winnerId, loserId));
  stmts.push(db.prepare('UPDATE evaluations SET entity_id = ? WHERE entity_id = ?').bind(winnerId, loserId));
  // Move the loser's outreach across. Nothing is deleted: a SENT or BOUNCED row
  // records something that actually happened to a real person, and sent history
  // is the one thing here that cannot be reconstructed.
  //
  // Since migration 005 the unique index only covers DRAFT rows, so history
  // moves freely. OR IGNORE covers the one case still possible — both sides
  // holding a draft for the same day — and the loser's draft is then dropped,
  // which is safe because a draft is not a record of anything.
  stmts.push(
    db.prepare('UPDATE OR IGNORE outreach SET entity_id = ? WHERE entity_id = ?')
      .bind(winnerId, loserId)
  );
  stmts.push(
    db.prepare("DELETE FROM outreach WHERE entity_id = ? AND status = 'DRAFT'").bind(loserId)
  );
  stmts.push(db.prepare('DELETE FROM entities WHERE id = ?').bind(loserId));

  await db.batch(stmts);
}

/**
 * Resolve a candidate to an entity, creating one only if genuinely new.
 *
 * Returns { id, created, merged }.
 */
export async function resolveEntity(db, candidate) {
  const { keys, strong, weak, domain, ig, tt, etsy, email } = identityKeys(candidate);
  if (!keys.length) return { id: null, created: false, merged: 0, reason: 'no-identity' };

  const found = await lookupKeys(db, keys);

  // Strong matches are proof. Weak matches are only accepted when nothing
  // about the existing entity contradicts them.
  const strongIds = new Set(strong.map((k) => found.get(k.key)).filter(Boolean));
  const weakIds = new Set(weak.map((k) => found.get(k.key)).filter(Boolean));

  for (const id of weakIds) {
    if (strongIds.has(id)) continue;
    if (!(await conflicts(db, id, { domain, ig, tt, etsy }))) strongIds.add(id);
  }

  const matchedIds = [...strongIds];

  let entityId;
  let created = false;
  let merged = 0;

  if (matchedIds.length === 0) {
    entityId = newId();
    created = true;
    const ts = nowIso();
    await db
      .prepare(
        `INSERT INTO entities
           (id, display_name, founder_name, website, domain, instagram, tiktok,
            etsy, niche, location_text, country, contact_email, contact_source,
            state, discovery_source, discovered_via, phone, osm_tags,
            has_website, first_seen_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        entityId,
        candidate.display_name || null,
        candidate.founder_name || null,
        candidate.website ? normalizeUrl(candidate.website) : null,
        domain || null,
        ig || null,
        tt || null,
        etsy || null,
        candidate.niche || null,
        candidate.location_text || null,
        candidate.country || 'US',
        email || null,
        candidate.contact_source || null,
        'DISCOVERED',
        candidate.discovery_source || 'unknown',
        candidate.discovered_via || null,
        candidate.phone || null,
        candidate.osm_tags ? JSON.stringify(candidate.osm_tags) : null,
        candidate.has_website === undefined ? null : (candidate.has_website ? 1 : 0),
        ts,
        ts
      )
      .run();
  } else {
    // Oldest wins, so the record with the longest history survives.
    const rows = await db
      .prepare(
        `SELECT id FROM entities WHERE id IN (${matchedIds.map(() => '?').join(',')})
         ORDER BY first_seen_at ASC`
      )
      .bind(...matchedIds)
      .all();
    const ordered = (rows.results || []).map((r) => r.id);
    entityId = ordered[0] || matchedIds[0];

    for (const loser of ordered.slice(1)) {
      await mergeEntities(db, entityId, loser);
      merged++;
    }
    await enrichExisting(db, entityId, candidate, { domain, ig, tt, etsy, email });
  }

  // Attach any key we did not already have.
  const missing = keys.filter((k) => !found.has(k.key));
  if (missing.length) {
    const ts = nowIso();
    await db.batch(
      missing.map((k) =>
        db
          .prepare(
            'INSERT OR IGNORE INTO entity_keys (key, kind, entity_id, created_at) VALUES (?,?,?,?)'
          )
          .bind(k.key, k.kind, entityId, ts)
      )
    );
  }

  return { id: entityId, created, merged };
}

/**
 * Would accepting a weak (slug/name) match contradict something we already
 * know? Two entities that each have a *different* domain, Instagram, TikTok
 * or Etsy shop are different businesses, however similar their names look.
 */
async function conflicts(db, entityId, cand) {
  const row = await db
    .prepare('SELECT domain, instagram, tiktok, etsy FROM entities WHERE id = ?')
    .bind(entityId)
    .first();
  if (!row) return true;

  for (const field of ['domain', 'instagram', 'tiktok', 'etsy']) {
    if (row[field] && cand[fieldAlias(field)] && row[field] !== cand[fieldAlias(field)]) return true;
  }
  return false;
}

const fieldAlias = (f) => ({ domain: 'domain', instagram: 'ig', tiktok: 'tt', etsy: 'etsy' }[f]);

/** Fill blanks on an existing entity without ever overwriting known data. */
async function enrichExisting(db, entityId, candidate, norm) {
  const row = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(entityId).first();
  if (!row) return;

  const patch = {};
  const maybe = (col, val) => { if (val && !row[col]) patch[col] = val; };

  maybe('display_name', candidate.display_name);
  maybe('founder_name', candidate.founder_name);
  maybe('website', candidate.website ? normalizeUrl(candidate.website) : null);
  maybe('domain', norm.domain);
  maybe('instagram', norm.ig);
  maybe('tiktok', norm.tt);
  maybe('etsy', norm.etsy);
  maybe('contact_email', norm.email);
  maybe('contact_source', candidate.contact_source);
  maybe('location_text', candidate.location_text);
  maybe('niche', candidate.niche);
  maybe('phone', candidate.phone);
  if (candidate.osm_tags && !row.osm_tags) patch.osm_tags = JSON.stringify(candidate.osm_tags);
  if (candidate.has_website !== undefined && row.has_website === null) {
    patch.has_website = candidate.has_website ? 1 : 0;
  }

  if (!Object.keys(patch).length) return;
  const cols = Object.keys(patch);
  await db
    .prepare(`UPDATE entities SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...cols.map((c) => patch[c]), nowIso(), entityId)
    .run();
}
