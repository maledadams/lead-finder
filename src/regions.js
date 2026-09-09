// Where the crawl looks, decided from the UI.
//
// src/metros.js holds 1,123 built-in US boxes and remains the fallback. This
// module only adds to that list and subtracts from it, so an empty `regions`
// table means exactly today's behaviour — which is what makes this safe to ship
// before anyone has used it.
//
// A BOX, NOT A POINT. Overpass is queried by bounding box, so adding "Toronto"
// means deciding how much of Toronto. The size comes from the same rule as the
// built-in list: roughly 9km across for a town, 22km for a large city, with
// longitude scaled by 1/cos(latitude) so a box in Anchorage covers the same
// ground as one in Miami rather than a thin sliver.
//
// COUNTRIES ARE A LEGAL DECISION, NOT A GEOGRAPHIC ONE. CAN-SPAM covers the
// United States. The EU is GDPR; Canada is CASL, which requires consent BEFORE
// sending and fines per message. Nothing outside the US is swept until someone
// has acknowledged that, and `acknowledged_at` is the record.

import { METROS } from './metros.js';
import { newId, nowIso } from './entity.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

export const slugify = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Countries whose rules are not CAN-SPAM, and what that means in one line. */
export const COMPLIANCE = {
  US: null,
  CA: 'Canada is CASL: consent is required BEFORE you send, and fines are per message.',
  GB: 'The UK is PECR and UK GDPR. Business addresses are allowed; a lawful basis and an opt-out are not optional.',
  IE: 'Ireland is GDPR and ePrivacy.',
  AU: 'Australia is the Spam Act: consent, identification and a working unsubscribe.',
  NZ: 'New Zealand is the Unsolicited Electronic Messages Act.',
};

export const complianceNote = (country) => {
  const cc = String(country || 'US').toUpperCase();
  if (cc === 'US') return null;
  return COMPLIANCE[cc]
    || 'Outside the United States, CAN-SPAM does not apply and local rules do. In the EU and EEA that is GDPR, which needs a lawful basis before you send.';
};

/**
 * A box around a point, sized the way src/metros.js sizes its own.
 *
 * Exported because the country import needs it too, and two implementations of
 * this would drift into two differently shaped countries.
 */
export function boxAround(lat, lon, radius = 0.075) {
  const lonRadius = Math.min(radius / Math.max(Math.cos((lat * Math.PI) / 180), 0.45), radius * 2.2);
  return [
    Number((lat - radius).toFixed(4)), Number((lon - lonRadius).toFixed(4)),
    Number((lat + radius).toFixed(4)), Number((lon + lonRadius).toFixed(4)),
  ];
}

export async function listRegions(db, profileId) {
  const { results } = await db.prepare(
    `SELECT * FROM regions WHERE profile_id IS NULL OR profile_id = ?
     ORDER BY kind, priority DESC, name`
  ).bind(profileId || '').all();
  return results || [];
}

/**
 * The places this profile will actually sweep, in the order it will sweep them.
 *
 * Built-in boxes plus added ones, minus anything blocked, ordered by priority
 * and then by the built-in interleave. `nextMetros` takes it from here and
 * applies staleness.
 */
export async function metrosFor(db, profile) {
  if (!profile?.id) throw new Error('metrosFor needs a profile');
  const rows = await listRegions(db, profile.id);

  // A block is matched by slug against everything, built-in included. That is
  // the only way "never crawl Miami again" can mean it.
  const blocked = new Set(rows.filter((r) => r.kind === 'block' && r.active).map((r) => r.slug));

  // A profile's own configured list wins over the national default, exactly as
  // it did before this module existed.
  const base = Array.isArray(profile.metros) && profile.metros.length ? profile.metros : METROS;

  const added = rows
    .filter((r) => r.kind === 'city' && r.active && r.bbox)
    // A country that has not been acknowledged is configured but not swept.
    .filter((r) => String(r.country || 'US').toUpperCase() === 'US' || r.acknowledged_at)
    .map((r) => {
      try { return { slug: r.slug, bbox: JSON.parse(r.bbox), priority: r.priority || 0 }; }
      catch { return null; }
    })
    .filter(Boolean);

  const seen = new Set(added.map((a) => a.slug));
  const out = [
    ...added.sort((a, b) => b.priority - a.priority).map((a) => [a.slug, a.bbox]),
    ...base.filter(([slug]) => !seen.has(slug)),
  ];
  return blocked.size ? out.filter(([slug]) => !blocked.has(slug)) : out;
}

/**
 * Add one place by name.
 *
 * Geocoded through OSM's own service rather than trusted from typing: a box
 * five kilometres off centre finds nothing and reports it as an empty town,
 * which is indistinguishable from a place with no businesses in it.
 */
export async function addCity(db, { name, country = 'US', profileId = null, priority = 0, userAgent }) {
  const clean = String(name || '').trim().slice(0, 90);
  if (clean.length < 2) return { ok: false, error: 'name the place you want to add' };
  const cc = String(country || 'US').toUpperCase().slice(0, 2);

  const qs = new URLSearchParams({ q: clean, format: 'json', limit: '1', countrycodes: cc.toLowerCase() });
  let hit;
  try {
    const res = await fetch(`${NOMINATIM}?${qs}`, {
      headers: { 'User-Agent': userAgent || 'lead-finder (+https://github.com/maledadams/lead-finder)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `the geocoder answered ${res.status}` };
    hit = (await res.json())[0];
  } catch (err) {
    return { ok: false, error: `could not reach the geocoder: ${String(err?.message || err).slice(0, 90)}` };
  }
  if (!hit) return { ok: false, error: `nothing called "${clean}" was found in ${cc}` };

  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: 'the geocoder gave no coordinates' };

  return storeCity(db, {
    name: hit.display_name?.split(',')[0]?.trim() || clean,
    country: cc, profileId, priority, bbox: boxAround(lat, lon), source: 'nominatim',
  });
}

async function storeCity(db, { name, country, profileId, priority, bbox, source }) {
  const slug = `${slugify(name)}-${String(country).toLowerCase()}`;
  const clash = await db.prepare(
    "SELECT id FROM regions WHERE kind = 'city' AND slug = ? AND COALESCE(profile_id,'') = ?"
  ).bind(slug, profileId || '').first();
  if (clash) return { ok: false, error: `${name} is already on the list` };

  const id = newId();
  await db.prepare(
    `INSERT INTO regions (id, profile_id, kind, country, name, slug, bbox, priority,
                          active, source, acknowledged_at, created_at)
     VALUES (?,?,'city',?,?,?,?,?,1,?,?,?)`
  ).bind(id, profileId, country, name, slug, JSON.stringify(bbox), priority, source,
    country === 'US' ? nowIso() : null, nowIso()).run();

  return { ok: true, id, slug, name, country, bbox, needs_acknowledgement: country !== 'US' };
}

/** Never crawl this place again. Applies to the built-in boxes as well. */
export async function blockRegion(db, { slug, name, profileId = null, reason = '' }) {
  const key = slugify(slug || name);
  if (!key) return { ok: false, error: 'name the place to block' };
  const id = newId();
  await db.prepare(
    `INSERT OR REPLACE INTO regions
       (id, profile_id, kind, country, name, slug, bbox, priority, active, source, created_at)
     VALUES (?,?,'block','--',?,?,NULL,0,1,?,?)`
  ).bind(id, profileId, String(name || key).slice(0, 90), key,
    String(reason || 'blocked').slice(0, 120), nowIso()).run();
  return { ok: true, slug: key };
}

export async function removeRegion(db, id) {
  const res = await db.prepare('DELETE FROM regions WHERE id = ?').bind(id).run();
  return res?.meta?.changes ? { ok: true } : { ok: false, error: 'not-found' };
}

export async function setPriority(db, id, priority) {
  const n = Math.max(-10, Math.min(10, Math.round(Number(priority) || 0)));
  const res = await db.prepare('UPDATE regions SET priority = ? WHERE id = ?').bind(n, id).run();
  return res?.meta?.changes ? { ok: true, priority: n } : { ok: false, error: 'not-found' };
}

/** Acknowledge that a country is not covered by CAN-SPAM, and start sweeping it. */
export async function acknowledgeCountry(db, country, profileId = null) {
  const cc = String(country || '').toUpperCase().slice(0, 2);
  if (!cc) return { ok: false, error: 'which country?' };
  const res = await db.prepare(
    `UPDATE regions SET acknowledged_at = ?
     WHERE kind = 'city' AND country = ? AND COALESCE(profile_id,'') = ? AND acknowledged_at IS NULL`
  ).bind(nowIso(), cc, profileId || '').run();
  return { ok: true, country: cc, activated: res?.meta?.changes || 0 };
}

/**
 * Import a country's cities in one Overpass query.
 *
 * `place=city` only, and capped. Towns would multiply this by ten for leads
 * that are mostly not there, and an uncapped import would put thousands of
 * boxes in front of a crawl that sweeps twelve a day.
 */
export async function importCountry(db, { country, limit = 60, profileId = null }) {
  const cc = String(country || '').toUpperCase().slice(0, 2);
  if (!/^[A-Z]{2}$/.test(cc)) return { ok: false, error: 'give a two-letter country code, like CA or GB' };

  const query = `[out:json][timeout:60];area["ISO3166-1"="${cc}"][admin_level=2]->.c;`
    + `node["place"="city"](area.c);out center ${Math.min(Number(limit) || 60, 200)};`;
  let elements;
  try {
    const res = await fetch(`${OVERPASS}?data=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, error: `Overpass answered ${res.status}` };
    elements = (await res.json())?.elements || [];
  } catch (err) {
    return { ok: false, error: `could not reach Overpass: ${String(err?.message || err).slice(0, 90)}` };
  }
  if (!elements.length) return { ok: false, error: `no cities came back for ${cc}` };

  const added = [];
  const skipped = [];
  for (const el of elements) {
    const name = el?.tags?.name;
    const lat = Number(el?.lat ?? el?.center?.lat);
    const lon = Number(el?.lon ?? el?.center?.lon);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Bigger than the default: a city named as a city deserves a city's box.
    const res = await storeCity(db, {
      name, country: cc, profileId, priority: 0,
      bbox: boxAround(lat, lon, 0.11), source: 'overpass',
    });
    if (res.ok) added.push(res.slug); else skipped.push(name);
  }

  return {
    ok: true,
    country: cc,
    added: added.length,
    already_present: skipped.length,
    compliance: complianceNote(cc),
    // Configured but dormant. Acknowledging the rules is what starts the sweep.
    needs_acknowledgement: cc !== 'US' && added.length > 0,
  };
}
