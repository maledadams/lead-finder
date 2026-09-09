// Oliver's working tool.
//
// This is not a stats page. One person opens it each morning, works down a
// list, and for each business decides: send this, or don't — and says why.
// That "why" is the most valuable output of the whole system, because it is
// what teaches the scoring which businesses Lucia actually wants.
//
// Design rules that follow from that:
//   - No internal vocabulary. No "entity", "frontier", "prescore", "state".
//   - The draft is visible on the card, not one click away.
//   - Skipping ALWAYS asks for a reason. A skip with no reason teaches nothing.
//   - The score is shown as a phrase, not a number to argue with.
//
// Four pages behind one rail: Today is the work, and Sent / Skipped / Bounced
// are the record. The record pages are rows rather than cards — they are
// scanned, not read, and a card around every one of them is just furniture.
//
// Fonts are the system stack on purpose. cspFor() in index.js sets
// `default-src 'none'` with no font-src, and loosening that on a page which
// renders text scraped from strangers' websites is a bad trade for a typeface.

import { renderMetrics } from './metrics.js';
import { bookingUrl } from './outreach.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PER_PAGE = 50;

const TITLES = {
  today: 'Today',
  sent: 'Sent',
  skipped: 'Skipped',
  bounced: 'Bounced',
  metrics: 'Metrics',
  calendar: 'Calendar',
};

/**
 * The rail icons.
 *
 * Inlined rather than pulled from an icon package, which is not a compromise
 * here: the CSP is `default-src 'none'` with no host allowed, so a CDN icon
 * font or sprite sheet cannot load at all, and shipping a dependency to render
 * six 24px glyphs would be heavier than the glyphs. Drawn in the Phosphor
 * manner — 24px box, single stroke weight, round caps — so they read as one set.
 */
const ICONS = {
  today: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8.2 12.4l2.9 2.9 4.7-5.9"/>',
  sent: '<path d="M20.6 3.4 3.4 9.9l7.1 3.6 3.6 7.1z"/><path d="M10.5 13.5 20.6 3.4"/>',
  skipped: '<circle cx="12" cy="12" r="8.5"/><path d="M6.4 17.6 17.6 6.4"/>',
  bounced: '<path d="M8.2 3.6 3.4 8.4l4.8 4.8"/><path d="M3.4 8.4h11.2a5.9 5.9 0 0 1 5.9 5.9v6.1"/>',
  metrics: '<path d="M4 20h16"/><path d="M7.6 20v-7.4"/><path d="M12 20V6.6"/><path d="M16.4 20v-4.6"/>',
  calendar: '<rect x="3.5" y="5.8" width="17" height="14.7" rx="3.2"/><path d="M8.2 3v4M15.8 3v4M3.5 10.6h17"/>',
  glass: '<circle cx="10.8" cy="10.8" r="6.9"/><path d="M15.9 15.9 21 21"/>',
};

const icon = (name) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"`
  + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

export async function renderDashboard(db, env, opts = {}) {
  const {
    view = 'today', nonce = '', signedInAs = null, sending = null,
    day, page = 1, q = '', from = null, to = null, profile, profiles = [],
  } = opts;
  // Every count and every row below is scoped to this. Switching profile has to
  // change the numbers, so a missing one fails instead of totalling both.
  if (!profile?.id) throw new Error('renderDashboard needs a profile');
  const pid = profile.id;

  const counts = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM outreach WHERE profile_id = ?1 AND queue_date = ?2 AND status = 'DRAFT') AS todo,
       (SELECT COUNT(*) FROM outreach WHERE profile_id = ?1 AND status = 'SENT')    AS sent,
       (SELECT COUNT(*) FROM outreach WHERE profile_id = ?1 AND status = 'SKIPPED') AS skipped,
       (SELECT COUNT(*) FROM outreach WHERE profile_id = ?1 AND status = 'BOUNCED') AS bounced,
       (SELECT COUNT(*) FROM entities WHERE profile_id = ?1 AND state = 'CONTACTED') AS contacted`
  ).bind(pid, day).first() || {};

  const body = view === 'calendar'
    ? calendarView(opts.calendar, env)
    : view === 'today'
      ? await todayView(db, pid, day, sending, profile)
      : view === 'metrics'
        ? await renderMetrics(db, env, { period: opts.period || 'month', profile })
        : await historyView(db, pid, view, { page, q, from, to }, profile);

  return shell({ view, nonce, signedInAs, sending, counts, body, profile, profiles, env });
}

// ---------------------------------------------------------------------------
// Calendar — the one thing both profiles share.
//
// Every email in every profile ends with the same 15-minute booking link,
// because one person has one diary. So this page is not scoped: it shows what is
// booked, whoever wrote to them, and says so rather than leaving it ambiguous.
//
// Read-only on purpose. Cal.com already has a good interface for moving a call;
// duplicating it here would only give two places to get it wrong.
// ---------------------------------------------------------------------------

function calendarView(cal, env) {
  const link = bookingUrl(env);
  const head = `
<div class="head"><h1>Upcoming calls</h1></div>
<p class="cap">Shared by every profile — one diary, one booking link. ${
  link ? `Recipients book at <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link.replace(/^https?:\/\//, ''))}</a>.`
       : 'No booking link is configured, so the emails invite a reply instead.'}</p>`;

  if (!cal || (!cal.ok && cal.error === 'not-configured')) {
    return `${head}
<div class="empty"><b>Cal.com is not connected.</b><br>
Set the key once and this fills in:<br>
<code>wrangler secret put CAL_API_KEY</code></div>`;
  }
  if (!cal.ok) {
    return `${head}
<div class="empty"><b>Cal.com did not answer.</b><br>${esc(cal.error)}<br>
Nothing is wrong with the leads — this page is the only thing affected.</div>`;
  }

  const bookings = cal.bookings || [];
  if (!bookings.length) {
    return `${head}
<div class="empty"><b>Nothing booked yet.</b><br>
Every draft offers the call, so this fills up from the replies rather than from here.</div>`;
  }

  // Grouped by day, because "what is on Thursday" is the actual question. The
  // dates are formatted in UTC here and rewritten to the reader's own timezone
  // by the script at the bottom of the page — a Worker has no idea where the
  // person reading it is, and a call an hour out is worse than useless.
  const byDay = new Map();
  for (const b of bookings) {
    const day = String(b.start).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }

  const sections = [...byDay.entries()].map(([day, items]) => `
<h2><time class="d" datetime="${esc(day)}">${esc(day)}</time></h2>
<div class="rows">
${items.map((b) => `
  <div class="row">
    <div class="rmain">
      <h3>${esc(b.name || b.title || 'Call')}</h3>
      <div class="dim sub">${esc(b.title || '')}${
        b.email ? ` &middot; <span class="mono">${esc(b.email)}</span>` : ''}</div>
      ${b.location && /^https?:/.test(b.location)
        ? `<div class="links"><a href="${esc(b.location)}" target="_blank" rel="noopener noreferrer">Join the call</a></div>`
        : ''}
    </div>
    <div class="rmeta">
      <div class="when"><time class="t" datetime="${esc(b.start)}">${esc(String(b.start).slice(11, 16))} UTC</time></div>
      ${b.status && b.status !== 'accepted'
        ? `<span class="pill weak">${esc(b.status)}</span>` : ''}
    </div>
  </div>`).join('')}
</div>`).join('');

  return head + sections;
}

// ---------------------------------------------------------------------------
// Today — the work itself.
// ---------------------------------------------------------------------------

async function todayView(db, pid, day, sending, profile) {
  const [queue, lessons, recent] = await Promise.all([
    db.prepare(
      `SELECT o.id AS oid, o.rank, o.subject, o.body, o.status, o.persona, o.edited_at,
              e.id AS eid, e.display_name, e.website, e.domain, e.instagram,
              e.phone, e.contact_email, e.score, e.niche, e.location_text,
              e.website_opportunity, e.system_opportunity, e.power_signals,
              e.personalization, e.has_website
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.profile_id = ? AND o.queue_date = ? ORDER BY o.rank ASC`
    ).bind(pid, day).all(),
    db.prepare(
      `SELECT lesson, kind, weight FROM lessons
       WHERE profile_id = ? AND active = 1 ORDER BY weight DESC LIMIT 6`
    ).bind(pid).all(),
    db.prepare(
      `SELECT f.decision, f.reason, e.display_name FROM feedback f
       JOIN entities e ON e.id = f.entity_id
       WHERE f.profile_id = ? AND f.reason IS NOT NULL
       ORDER BY f.created_at DESC LIMIT 4`
    ).bind(pid).all(),
  ]);

  const canSend = Boolean(sending?.connected);
  const rows = queue.results || [];
  const todo = rows.filter((r) => r.status === 'DRAFT');
  const done = rows.filter((r) => r.status !== 'DRAFT');

  return `
<div class="head">
  <h1>Leads to review</h1>
  <input type="date" id="day" value="${esc(day)}" aria-label="Show another day">
</div>

<div class="prog">
  <span><b>${todo.length}</b> to review</span>
  ${canSend
    ? `<span class="ok"><b>${esc(sending.sent_today)}/${esc(sending.daily_cap)}</b> sent via Zoho today</span>`
    : '<span class="warn">sending not connected — copy &amp; paste</span>'}
</div>

${todo.length ? todo.map((r) => card(r, canSend, profile)).join('') : `<div class="empty">
  <b>Nothing to review right now.</b><br>
  New leads are found overnight and appear here each morning.
</div>`}

${done.length ? `<h2>Already handled today</h2>${done.map((r) => card(r, canSend, profile)).join('')}` : ''}

${(lessons.results || []).length ? `<h2>What this has learned from you</h2>
<div class="panel"><ul class="lessons">
${lessons.results.map((l) => `<li>${esc(l.lesson)}
  <span class="k">${l.kind === 'PREFER' ? 'look for this' : 'avoid this'}${l.weight > 1 ? ` &middot; seen ${l.weight}&times;` : ''}</span></li>`).join('')}
</ul></div>` : ''}

${(recent.results || []).length ? `<h2>Recent notes</h2>
<div class="panel">${recent.results.map((r) =>
  `<div class="note"><b>${esc(r.display_name || '')}</b>
   <span class="k">${esc(String(r.decision).toLowerCase())}</span><br>
   <span class="dim">${esc(r.reason)}</span></div>`).join('')}</div>` : ''}
`;
}

function card(r, CAN_SEND = false, profile = null) {
  const p = safe(r.personalization) || {};
  const power = safe(r.power_signals) || [];
  const niche = profile?.niches?.[r.niche]?.label || r.niche || 'Business';
  const belowBar = String(r.persona || '').includes('below_bar');
  const noSite = r.has_website === 0;
  const isDone = r.status !== 'DRAFT';
  const status = String(r.status).toLowerCase();

  // Purchasing-power signals, said in English rather than as field names.
  const money = power.slice(0, 3).map((s) => String(s).replace(/_/g, ' ')).join(' · ');

  const tag = isDone
    ? `<span class="pill ${status}">${esc(status)}</span>`
    : belowBar
      ? '<span class="pill weak">worth a look</span>'
      : '<span class="pill strong">strong match</span>';

  return `<div class="card ${isDone ? 'done' : ''}" data-oid="${esc(r.oid)}" data-eid="${esc(r.eid)}">
  <div class="top">
    <span class="nm">${esc(r.display_name || r.domain || 'Unnamed business')}</span>
    ${r.location_text ? `<span class="dim sm">${esc(r.location_text)}</span>` : ''}
    ${tag}
  </div>
  <div class="dim sm">${esc(niche)}${money ? ` &middot; ${esc(money)}` : ''}</div>

  <div class="links">
    ${r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener noreferrer">Their website</a>` : ''}
    ${r.instagram ? `<a href="https://instagram.com/${esc(r.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>` : ''}
    ${r.contact_email
      ? `<span class="dim">${esc(r.contact_email)}</span>`
      : '<span class="warn">no address on file</span>'}
    <button class="link" data-open="email">${r.contact_email ? 'change' : 'add an address'}</button>
  </div>
  ${emailDrawer(r)}

  ${noSite
    ? '<div class="why"><b>Why:</b> they have no website at all — that is the whole opportunity.</div>'
    : `${r.website_opportunity ? `<div class="why"><b>Website:</b> ${esc(trim(r.website_opportunity))}</div>` : ''}
       ${r.system_opportunity ? `<div class="why"><b>Could also use:</b> ${esc(trim(r.system_opportunity))}</div>` : ''}`}
  ${p.liked ? `<div class="why"><b>Noticed:</b> ${esc(p.liked)}</div>` : ''}

  <details${isDone ? '' : ' open'}>
    <summary>The email — ${esc(r.subject)}${r.edited_at ? ' (edited)' : ''}</summary>
    <div class="mail">${esc(r.body)}</div>
  </details>

  ${isDone ? doneActions(r, status) : `
  <div class="acts">
    ${CAN_SEND
      ? '<button class="go" data-act="send">Send it</button>'
      : '<button class="go" data-act="sent">I sent this</button>'}
    <button data-open="edit">Edit</button>
    <button data-copy="1">Copy email</button>
    ${CAN_SEND ? '<button data-act="sent">Already sent it myself</button>' : ''}
    <button class="no" data-open="reason">Skip &hellip;</button>
    ${noteControl()}
  </div>

  ${editor(r)}

  <div class="drawer" data-drawer="reason">
    <div class="hint">Why are you skipping? Be specific — this is what teaches it
      what to stop putting in front of you.</div>
    <textarea data-field="reason" placeholder="e.g. their site is already great and there is no obvious system to build"></textarea>
    <div class="acts">
      <button class="no" data-act="skip">Skip this one</button>
      <button data-act="block">Never contact them</button>
    </div>
  </div>`}
</div>`;
}

/** A handled row still has one thing left to say: that it bounced. */
function doneActions(r, status) {
  if (status !== 'sent') return '';
  return `
  <div class="acts">
    <button class="no" data-open="bounce">It bounced&hellip;</button>
  </div>
  ${bounceDrawer()}`;
}

function editor(r) {
  return `<div class="drawer" data-drawer="edit">
    <label class="lb" for="s-${esc(r.oid)}">Subject</label>
    <input id="s-${esc(r.oid)}" data-field="subject" value="${esc(r.subject)}" maxlength="200">
    <label class="lb" for="b-${esc(r.oid)}">Message</label>
    <textarea id="b-${esc(r.oid)}" data-field="body" class="tall">${esc(r.body)}</textarea>
    <div class="hint">The opt-out line and the postal address at the bottom are
      legally required. If you delete them they get put back.</div>
    <div class="acts">
      <button class="go" data-act="save">Save changes</button>
      <button data-act="cancel">Cancel</button>
    </div>
  </div>`;
}

function bounceDrawer() {
  return `<div class="drawer" data-drawer="bounce">
    <div class="hint">What did the bounce say? The business stays on the list —
      only the address is thrown away, and it comes back as soon as a different
      one turns up.</div>
    <textarea data-field="note" placeholder="e.g. mailer-daemon: 550 user unknown"></textarea>
    <div class="acts">
      <button class="no" data-act="bounce">Mark it bounced</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Sent / Skipped / Bounced — the record.
// ---------------------------------------------------------------------------

async function historyView(db, pid, view, { page, q, from, to }, profile) {
  const status = view.toUpperCase();

  // Each page is ordered and filtered by the date that actually means
  // something for it. Skipped has no timestamp of its own, so the day it was
  // queued is the closest honest answer.
  const dateCol = status === 'SENT' ? 'date(o.sent_at)'
    : status === 'BOUNCED' ? 'date(o.bounced_at)'
      : 'o.queue_date';
  const orderCol = status === 'SENT' ? 'o.sent_at'
    : status === 'BOUNCED' ? 'o.bounced_at'
      : 'o.created_at';

  const where = ['o.profile_id = ?', 'o.status = ?'];
  const args = [pid, status];
  if (q) {
    where.push('(e.display_name LIKE ? OR o.subject LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }
  if (from) { where.push(`${dateCol} >= ?`); args.push(from); }
  if (to) { where.push(`${dateCol} <= ?`); args.push(to); }
  const clause = where.join(' AND ');

  const total = (await db.prepare(
    `SELECT COUNT(*) AS n FROM outreach o JOIN entities e ON e.id = o.entity_id WHERE ${clause}`
  ).bind(...args).first())?.n || 0;

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(page, pages);

  // The reason lives in `feedback`, not on the outreach row. A correlated
  // subquery rather than a LEFT JOIN so two feedback rows for one email cannot
  // silently duplicate the line.
  const { results } = await db.prepare(
    `SELECT o.id AS oid, o.subject, o.body, o.status, o.queue_date, o.sent_at,
            o.bounced_at, o.sent_via, o.send_error, o.edited_at,
            e.id AS eid, e.display_name, e.domain, e.website, e.location_text,
            e.contact_email, e.niche, e.response_status,
            (SELECT f.reason FROM feedback f WHERE f.outreach_id = o.id
              ORDER BY f.created_at DESC LIMIT 1) AS reason,
            (SELECT f.decision FROM feedback f WHERE f.outreach_id = o.id
              ORDER BY f.created_at DESC LIMIT 1) AS decision
     FROM outreach o JOIN entities e ON e.id = o.entity_id
     WHERE ${clause}
     ORDER BY ${orderCol} DESC
     LIMIT ? OFFSET ?`
  ).bind(...args, PER_PAGE, (current - 1) * PER_PAGE).all();

  const rows = results || [];

  return `
<div class="head">
  <h1>${esc(TITLES[view])}</h1>
  <span class="dim sm">${total} in total</span>
</div>

<div class="filters">
  <div>
    <label class="lb" for="q">Search</label>
    <input id="q" type="search" value="${esc(q)}" placeholder="business or subject" data-filter="q">
  </div>
  <div>
    <label class="lb" for="from">From</label>
    <input id="from" type="date" value="${esc(from || '')}" data-filter="from">
  </div>
  <div>
    <label class="lb" for="to">To</label>
    <input id="to" type="date" value="${esc(to || '')}" data-filter="to">
  </div>
  ${q || from || to ? '<button data-act="clear">Clear</button>' : ''}
</div>

${rows.length ? `<div class="rows">${rows.map((r) => historyRow(r, view)).join('')}</div>`
    : `<div class="empty">${emptyFor(view, Boolean(q || from || to))}</div>`}

${pages > 1 ? pager(current, pages) : ''}
`;
}

/**
 * The note field, the one way the system is corrected.
 *
 * On a history row it lives in the right-hand column under the date and the
 * address, laid out horizontally, because that column is where the facts about
 * this send are and a correction is a fact about this send.
 */
function noteControl() {
  return `<span class="notes"><span class="nlab">Notes:</span><input class="npill"
      data-field="note" placeholder="what did it get wrong?" maxlength="200"
      autocomplete="off" aria-label="Correct this record"><button class="nsend"
      data-act="note" title="Send this note">Send note</button></span>`;
}

function historyRow(r, view) {
  const when = view === 'sent' ? r.sent_at : view === 'bounced' ? r.bounced_at : r.queue_date;
  const blocked = String(r.decision || '') === 'BLOCKED';

  return `<div class="row" data-oid="${esc(r.oid)}" data-eid="${esc(r.eid)}">
  <div class="rmain">
    <div class="top">
      <span class="nm">${esc(r.display_name || r.domain || 'Unnamed business')}</span>
      ${r.location_text ? `<span class="dim sm">${esc(r.location_text)}</span>` : ''}
      ${view === 'sent' ? statusPill(r) : ''}
      ${blocked ? '<span class="pill bounced">never contact</span>' : ''}
      ${r.edited_at ? '<span class="pill">edited</span>' : ''}
    </div>
    <div class="dim sm subj">${esc(r.subject)}</div>
    <div class="links sm">
      ${r.contact_email ? `<span class="dim">${esc(r.contact_email)}</span>` : '<span class="warn">no address on file</span>'}
      <button class="link" data-open="email">${r.contact_email ? 'change' : 'add an address'}</button>
    </div>
    ${emailDrawer(r)}
    ${view === 'skipped' && r.reason ? `<div class="why sm"><b>Reason:</b> ${esc(r.reason)}</div>` : ''}
    ${view === 'bounced' && r.send_error ? `<div class="why sm"><b>Bounce:</b> ${esc(r.send_error)}</div>` : ''}
    ${rowActions(r, view)}
  </div>
  <div class="rmeta">
    <div class="when">${esc(short(when))}</div>
    ${view === 'sent' && r.sent_via ? `<div class="dim sm">via ${esc(r.sent_via)}</div>` : ''}
    ${view === 'sent' && r.contact_email ? `<div class="dim sm">${esc(r.contact_email)}</div>` : ''}
    ${noteControl()}
  </div>
  <details class="wide">
    <summary>The email</summary>
    <div class="mail">${esc(r.body)}</div>
  </details>
</div>`;
}

/**
 * Set or correct the address, from anywhere.
 *
 * Most addresses are found by hand, so this is available on every lead at any
 * time rather than only after a bounce. It edits the business already on file —
 * nothing is duplicated — and the address is checked against the suppression
 * list and DNS before it is stored, so a dead one cannot be saved.
 */
function emailDrawer(r, { open = false } = {}) {
  const id = esc(r.oid || r.eid);
  return `<div class="drawer${open ? ' open' : ''}" data-drawer="email">
    <label class="lb" for="e-${id}">${r.contact_email ? 'Correct the address' : 'Add an address'}</label>
    <input id="e-${id}" data-field="email" type="email" value="${esc(r.contact_email || '')}"
           placeholder="hello@theirdomain.com" autocomplete="off" spellcheck="false">
    <div class="hint">Checked against the block list and DNS before it is saved.</div>
    <div class="acts">
      <button class="go" data-act="setemail">${r.contact_email ? 'Save correction' : 'Save address'}</button>
      ${open ? '' : '<button data-act="cancel">Cancel</button>'}
    </div>
  </div>`;
}

const STATUS_LABEL = {
  REPLIED: 'replied',
  NO_REPLY: 'no reply',
  GHOSTED: 'ghosted',
};

/**
 * What happened after the send.
 *
 * Blank means "sent, still waiting" rather than "nothing happened", so it is
 * shown as waiting rather than left empty. The nightly sweep fills in ghosted
 * for anything still blank after the cutoff; setting one by hand pins it, and
 * the sweep never overwrites it.
 */
function statusPill(r) {
  const st = String(r.response_status || '');
  if (!STATUS_LABEL[st]) return '<span class="pill">awaiting reply</span>';
  const tone = st === 'REPLIED' ? 'sent' : st === 'GHOSTED' ? 'bounced' : '';
  return `<span class="pill ${tone}">${STATUS_LABEL[st]}</span>`;
}

function rowActions(r, view) {
  if (view === 'sent') {
    const st = String(r.response_status || '');
    const btn = (val, label) => `<button data-act="status" data-status="${val}"${
      st === val ? ' disabled' : ''}>${label}</button>`;
    return `<div class="acts">
      ${btn('REPLIED', 'They replied')}
      ${btn('NO_REPLY', 'No reply')}
      ${btn('GHOSTED', 'Ghosted')}
      ${st ? '<button data-act="status" data-status="">Clear</button>' : ''}
      <button class="no" data-open="bounce">It bounced&hellip;</button>
    </div>${bounceDrawer()}`;
  }
  if (view === 'skipped') {
    return `<div class="acts">
      <button data-act="revive">Edit &amp; put back in the queue</button>
    </div>`;
  }
  // bounced: only offer the requeue once there is somewhere to send it.
  return `<div class="acts">
    <button data-act="revive"${r.contact_email ? '' : ' disabled'}>Edit &amp; put back in the queue</button>
    ${r.contact_email ? '' : '<span class="dim sm">needs an address first</span>'}
  </div>`;
}

function emptyFor(view, filtered) {
  if (filtered) return '<b>Nothing matches those filters.</b><br>Try clearing them.';
  if (view === 'sent') return '<b>No emails sent yet.</b><br>They appear here once you send one from Today.';
  if (view === 'skipped') return '<b>Nothing skipped yet.</b><br>Skipped leads and your reasons collect here.';
  return '<b>No bounces.</b><br>Addresses that turn out to be dead show up here.';
}

function pager(current, pages) {
  const link = (n, label, on) => on
    ? `<button data-page="${n}">${label}</button>`
    : `<button disabled>${label}</button>`;
  return `<div class="pager">
    ${link(current - 1, 'Previous', current > 1)}
    <span class="dim">Page ${current} of ${pages}</span>
    ${link(current + 1, 'Next', current < pages)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Chrome: rail, styles, and the one inline script.
// ---------------------------------------------------------------------------

/**
 * The page around the view.
 *
 * Styled to HeroUI's design language rather than built on HeroUI, which needs
 * React 18, Tailwind v4, Framer Motion and a build step. The tokens below are
 * HeroUI's own — the #006FEE primary and its 50-900 scale, its zinc-based
 * content surfaces, its radii and shadow scale — so the result reads as HeroUI
 * while the page stays a single ~8KB response with no external requests and
 * the CSP untouched at `default-src 'none'`.
 *
 * Light is the default. Dark is a deliberate choice, remembered per browser,
 * not a reflection of the OS setting.
 */
function shell({ view, nonce, signedInAs, sending, counts, body, profile, profiles }) {
  // Every link carries the profile, so a middle-click into a new tab lands in
  // the same operation rather than in whichever one is default.
  const qs = `?profile=${encodeURIComponent(profile.slug)}`;
  const item = (href, key, label, n) =>
    `<a class="nav" href="${href}${qs}"${view === key ? ' aria-current="page"' : ''}>${
      icon(key)}<span>${esc(label)}</span>${n ? `<span class="n">${n}</span>` : ''}</a>`;

  const options = (profiles.length ? profiles : [profile]).map((p) =>
    `<option value="${esc(p.slug)}"${p.slug === profile.slug ? ' selected' : ''}>${
      esc(p.name)}</option>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PGNpcmNsZSBjeD0nMTQnIGN5PScxNCcgcj0nOC41JyBmaWxsPSdub25lJyBzdHJva2U9JyMwMDZGRUUnIHN0cm9rZS13aWR0aD0nMy4yJy8+PHBhdGggZD0nTTIwLjQgMjAuNCAyNyAyNycgc3Ryb2tlPScjMDA2RkVFJyBzdHJva2Utd2lkdGg9JzMuNicgc3Ryb2tlLWxpbmVjYXA9J3JvdW5kJy8+PC9zdmc+">
<title>${esc(TITLES[view] || 'Leads')} — leads</title>
<style>
  /* ---- HeroUI tokens ------------------------------------------------- */
  :root{
    --p50:#E6F1FE; --p100:#CCE3FD; --p200:#99C7FB; --p300:#66AAF9; --p400:#338EF7;
    --p500:#006FEE; --p600:#005BC4; --p700:#004493; --p800:#002E62; --p900:#001731;

    --bg:#FFFFFF; --fg:#11181C;
    --c-1:#FFFFFF; --c-2:#f4f4f5; --c-3:#e4e4e7; --c-4:#d4d4d8;
    --line:#e4e4e7; --muted:#52525b; --accent:var(--p500); --accent-ink:#FFFFFF;
    --ok:#0E793C; --warn:#936316; --bad:#C20E4D;
    --ring:0 0 0 3px rgba(0,111,238,.35);
    --sh-s:0 1px 2px rgba(17,24,28,.06),0 1px 3px rgba(17,24,28,.05);
    --sh-m:0 4px 12px rgba(17,24,28,.07);
    --r-s:8px; --r-m:12px; --r-l:14px; --r-xl:18px;

    /* Chart marks. Validated as a set against this surface — every check in
       the palette validator passes at #FFFFFF. Never reordered: colour follows
       the series, not its rank. */
    --c1:#006FEE; --c2:#C4841D; --c3:#7828C8; --c4:#12A150; --c5:#C20E4D;
  }
  :root[data-theme="dark"]{
    --bg:#000000; --fg:#ECEDEE;
    --c-1:#18181b; --c-2:#27272a; --c-3:#3f3f46; --c-4:#52525b;
    --line:#27272a; --muted:#a1a1aa; --accent:var(--p500); --accent-ink:#FFFFFF;
    --ok:#17C964; --warn:#F5A524; --bad:#F871A0;
    --sh-s:0 1px 2px rgba(0,0,0,.5); --sh-m:0 4px 14px rgba(0,0,0,.55);
    /* Re-stepped for the dark surface, not flipped: these are their own
       validated steps against #18181b. */
    --c1:#006FEE; --c2:#C4841D; --c3:#9353D3; --c4:#12A150; --c5:#C20E4D;
  }

  /* With the toggle gone, the operating system is what chooses. Same steps,
     under the media query, so dark mode is reachable without a button. The
     [data-theme] selectors above stay: they are how the choice would be
     honoured if one is ever wanted back. */
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
    --bg:#000000; --fg:#ECEDEE;
    --c-1:#18181b; --c-2:#27272a; --c-3:#3f3f46; --c-4:#52525b;
    --line:#27272a; --muted:#a1a1aa; --accent:var(--p500); --accent-ink:#FFFFFF;
    --ok:#17C964; --warn:#F5A524; --bad:#F871A0;
    --sh-s:0 1px 2px rgba(0,0,0,.5); --sh-m:0 4px 14px rgba(0,0,0,.55);
    /* Re-stepped for the dark surface, not flipped: these are their own
       validated steps against #18181b. */
    --c1:#006FEE; --c2:#C4841D; --c3:#9353D3; --c4:#12A150; --c5:#C20E4D;
  }
  }

  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
       -webkit-font-smoothing:antialiased}
  a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--line);
    text-underline-offset:2px}
  a:hover{text-decoration-color:var(--muted)}
  :focus-visible{outline:none;box-shadow:var(--ring);border-radius:var(--r-s)}

  /* ---- frame --------------------------------------------------------- */
  .app{display:grid;grid-template-columns:232px 1fr;min-height:100dvh}
  .rail{background:var(--c-1);border-right:1px solid var(--line);position:sticky;top:0;
        align-self:start;height:100dvh;padding:20px 14px;display:flex;
        flex-direction:column;gap:2px}
  .brand{display:flex;align-items:center;gap:9px;padding:2px 10px 14px;font-weight:700;
         letter-spacing:-.02em;font-size:15px}
  .brand .ico{color:var(--accent);width:18px;height:18px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none}
  .ico{width:17px;height:17px;flex:none}

  /* Profile switcher. Switching is switching account, so it sits above the
     navigation rather than beside the sign-out line. */
  .psel{display:block;padding:0 3px 14px;margin-bottom:6px;border-bottom:1px solid var(--line)}
  .plab{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.09em;
        color:var(--muted);font-weight:600;margin:0 8px 5px}
  .psel select{width:100%;font:inherit;font-size:13.5px;font-weight:600;color:var(--fg);
        background:var(--c-2);border:1px solid var(--line);border-radius:var(--r-s);
        padding:7px 9px;cursor:pointer}
  .newp{margin-top:8px;font-size:12.5px;color:var(--muted)}
  .newp>summary{cursor:pointer;padding:7px 11px;border-radius:var(--r-s);list-style:none}
  .newp>summary::-webkit-details-marker{display:none}
  .newp>summary::before{content:'+ ';font-weight:700}
  .newp>summary:hover{background:var(--c-2);color:var(--fg)}
  .newp input,.newp textarea{width:100%;font:inherit;font-size:12.5px;margin:6px 0 0;
        padding:7px 9px;border:1px solid var(--line);border-radius:var(--r-s);
        background:var(--c-1);color:var(--fg);resize:vertical}
  .newp button{margin-top:7px;width:100%}
  .nav{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:var(--r-s);
       text-decoration:none;font-size:14px;white-space:nowrap;color:var(--muted);
       transition:background .15s,color .15s}
  .nav:hover{background:var(--c-2);color:var(--fg)}
  .nav[aria-current="page"]{background:var(--p50);color:var(--p600);font-weight:600}
  :root[data-theme="dark"] .nav[aria-current="page"]{background:rgba(0,111,238,.18);color:var(--p300)}
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]) .nav[aria-current="page"]{background:rgba(0,111,238,.18);color:var(--p300)}
  }
  .nav .n{margin-left:auto;font-size:12px;font-variant-numeric:tabular-nums;
          background:var(--c-2);color:var(--muted);padding:1px 7px;border-radius:99px}
  .nav[aria-current="page"] .n{background:var(--p100);color:var(--p700)}
  :root[data-theme="dark"] .nav[aria-current="page"] .n{background:rgba(0,111,238,.3);color:var(--p200)}
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]) .nav[aria-current="page"] .n{background:rgba(0,111,238,.3);color:var(--p200)}
  }
  .foot{margin-top:auto;padding:12px 11px 0;font-size:12px;color:var(--muted);line-height:1.6;
        border-top:1px solid var(--line)}
  .foot b{font-variant-numeric:tabular-nums;color:var(--fg)}

  .main{min-width:0;max-width:1160px;padding:26px 30px 110px}
  .head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:20px}
  h1{font-size:22px;margin:0;letter-spacing:-.022em;font-weight:700}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
     margin:34px 0 12px;font-weight:600}
  h3{font-size:15px;margin:0 0 2px;font-weight:650;letter-spacing:-.01em}
  .cap{font-size:13px;color:var(--muted);margin:0 0 16px;max-width:56ch}
  .dim,.dimmed{color:var(--muted)}
  .sm{font-size:13px}
  .ok{color:var(--ok)} .warn{color:var(--warn)}
  .prog{display:flex;gap:16px;font-size:14px;margin:0 0 22px;flex-wrap:wrap}
  .prog b{font-variant-numeric:tabular-nums}

  /* ---- surfaces ------------------------------------------------------ */
  .card{background:var(--c-1);border:1px solid var(--line);border-radius:var(--r-xl);
        padding:18px 20px;margin-bottom:14px;box-shadow:var(--sh-s)}
  .card.done{background:transparent;box-shadow:none}
  .top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:2px}
  .nm{font-size:16px;font-weight:650;letter-spacing:-.01em}
  .pill{margin-left:auto;font-size:11.5px;padding:3px 9px;border-radius:99px;
        background:var(--c-2);color:var(--muted);white-space:nowrap;font-weight:500}
  .pill.strong,.pill.sent{background:color-mix(in srgb,var(--ok) 12%,transparent);color:var(--ok)}
  .pill.weak,.pill.bounced{background:color-mix(in srgb,var(--warn) 10%,transparent);color:var(--warn)}
  .links{font-size:13.5px;margin:8px 0 10px;display:flex;gap:14px;flex-wrap:wrap}
  .why{font-size:14px;margin:10px 0;padding-left:12px;border-left:2px solid var(--line)}
  .why.sm{font-size:13px;margin:6px 0}
  details{margin:12px 0 0}
  summary{cursor:pointer;font-size:13.5px;color:var(--muted);user-select:none;padding:6px 0}
  /* Fills the card. It used to stop at 68ch inside a 1100px column, which left
     a narrow block sitting in a much wider box and looked misaligned. */
  .mail{background:var(--c-2);border-radius:var(--r-m);padding:16px 18px;white-space:pre-wrap;
        font-size:13.5px;line-height:1.7;margin-top:8px;width:100%;display:block}

  .rows{border-top:1px solid var(--line);margin-top:18px}
  .row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 20px;padding:15px 4px;
       border-bottom:1px solid var(--line)}
  .rmain{min-width:0} .subj{margin-top:2px}
  .rmeta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;
         text-align:right;white-space:nowrap}
  /* The note field stays in this column, under the date and the address, but
     drops to the bottom of it so it lines up with the row's buttons rather than
     hanging off the date. An auto top margin in a stretched grid cell does that,
     and it needs no knowledge of how tall the row happens to be. */
  .rmeta .notes{margin-top:auto;width:auto}
  .rmeta .npill{flex:0 1 180px;min-width:130px}

  /* The email reads at the width it does on Today: across the whole row rather
     than inside the left column, which the date and note column was narrowing. */
  .row>details.wide{grid-column:1/-1;margin:2px 0 0}
  .when{font-size:13px;font-variant-numeric:tabular-nums}
  .row .pill{margin-left:0}

  .filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:18px}
  .filters input{font:inherit;font-size:13.5px;padding:8px 11px;border-radius:var(--r-s);
    border:1px solid var(--line);background:var(--c-2);color:var(--fg)}
  .lb{display:block;font-size:12px;color:var(--muted);margin:0 0 4px}

  button{font:inherit;font-size:13.5px;padding:8px 15px;border-radius:var(--r-s);cursor:pointer;
         border:1px solid var(--line);background:var(--c-1);color:var(--fg);font-weight:500;
         display:inline-flex;align-items:center;gap:6px;
         transition:background .15s,border-color .15s,transform .06s,opacity .15s}
  button:hover:not(:disabled){background:var(--c-2)}
  button:active:not(:disabled){transform:scale(.975)}
  button.go{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
  button.go:hover:not(:disabled){background:var(--p600);border-color:var(--p600)}
  button.no{border-color:transparent;background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad)}
  button.no:hover:not(:disabled){background:color-mix(in srgb,var(--bad) 20%,transparent)}
  button:disabled{opacity:.45;cursor:default}
  .acts{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}
  .notes{display:flex;align-items:center;gap:7px;margin-left:auto;flex:1;min-width:280px;max-width:520px}
  /* On a history row the notes belong at the right-hand end, as one group.
     Growing to fill made them start where the buttons stop, which is why they
     read as left-aligned no matter how much room was left over. */
  .row .notes{flex:0 1 auto;min-width:0;justify-content:flex-end}
  .row .npill{flex:0 1 230px;min-width:150px}
  .nlab{font-size:12.5px;color:var(--muted);white-space:nowrap}
  .nsend{padding:6px 13px;border-radius:99px;font-size:12.5px;white-space:nowrap;flex:none}
  .npill{font:inherit;font-size:13px;padding:6px 13px;border-radius:99px;
         flex:1;min-width:180px;
         border:1px solid var(--line);background:var(--c-2);color:var(--fg);
         transition:border-color .15s,background .15s}
  .npill:focus{background:var(--c-1);border-color:var(--accent);outline:none}
  .npill:disabled{opacity:.5}
  @media (max-width:768px){ .notes{margin-left:0;width:100%} .npill{flex:1;width:auto} }
  button.link{background:none;border:0;padding:0;font-size:13px;color:var(--accent);
              text-decoration:underline;text-underline-offset:2px;font-weight:500}
  button.link:hover:not(:disabled){background:none;color:var(--p600)}

  .drawer{display:none;margin-top:12px}
  .drawer.open{display:block}
  /* An email field sized to an email. Full width made a 21-character address
     sit in a box the width of the page. */
  .drawer input[data-field="email"]{width:24ch;max-width:100%}
  .drawer input,.drawer textarea{width:100%;font:inherit;font-size:13.5px;
    padding:10px 12px;border-radius:var(--r-m);border:1px solid var(--line);
    background:var(--c-2);color:var(--fg)}
  .drawer textarea{min-height:64px;line-height:1.65;resize:vertical}
  .drawer textarea.tall{min-height:300px}
  .hint{font-size:12.5px;color:var(--muted);margin:6px 0 8px;max-width:60ch}

  .empty,.nodata{background:var(--c-2);border:1px dashed var(--line);border-radius:var(--r-l);
         padding:32px;text-align:center;color:var(--muted);margin-top:14px;font-size:13.5px}
  .empty b{color:var(--fg)}
  .panel{background:var(--c-1);border:1px solid var(--line);border-radius:var(--r-l);
         padding:14px 18px;box-shadow:var(--sh-s)}
  .lessons{margin:0;padding-left:18px} .lessons li{font-size:13.5px;margin:4px 0}
  .k{color:var(--muted);font-size:11.5px} .note{font-size:13.5px;margin:8px 0}
  .pager{display:flex;gap:12px;align-items:center;margin-top:22px;font-size:13.5px}

  /* ---- metrics ------------------------------------------------------- */
  .seg{margin-left:auto;display:inline-flex;background:var(--c-2);border-radius:var(--r-m);padding:3px;gap:2px}
  .sgi{padding:6px 13px;border-radius:9px;font-size:13px;text-decoration:none;color:var(--muted);
       white-space:nowrap;transition:background .15s,color .15s}
  .sgi:hover{color:var(--fg)}
  .sgi.on{background:var(--c-1);color:var(--fg);font-weight:600;box-shadow:var(--sh-s)}
  .grid{display:grid;gap:14px;margin-bottom:14px}
  .grid.stats{grid-template-columns:repeat(4,1fr)}
  .grid.two{grid-template-columns:1fr 1fr}
  .grid section{margin-bottom:0}
  .stat{background:var(--c-1);border:1px solid var(--line);border-radius:var(--r-xl);
        padding:16px 18px;box-shadow:var(--sh-s)}
  .sl{font-size:12.5px;color:var(--muted);margin-bottom:6px}
  .sv{font-size:29px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.1}
  .sv.good{color:var(--ok)} .sv.bad{color:var(--bad)}
  .ss{font-size:12.5px;color:var(--muted);margin-top:5px}

  .fig{display:flex;flex-direction:column;gap:14px}
  .arc{transition:opacity .15s} .fig:hover .arc{opacity:.55} .arc:hover{opacity:1}
  .ctr{text-anchor:middle;font-size:21px;font-weight:700;fill:var(--fg);
       font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .ctrsub{text-anchor:middle;font-size:10.5px;fill:var(--muted)}
  .legend{list-style:none;margin:0;padding:0;display:grid;gap:7px;font-size:13px}
  .legend.row{display:flex;gap:16px;flex-wrap:wrap}
  .legend li{display:flex;align-items:center;gap:8px}
  .sw{width:10px;height:10px;border-radius:3px;flex:none}
  .legend .lb{margin:0;color:var(--fg);font-size:13px}
  .legend .vl{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--muted)}

  .bars{display:grid;gap:9px}
  .bar{display:grid;grid-template-columns:minmax(88px,30%) 1fr auto;align-items:center;
       gap:12px;font-size:13px}
  .bl{color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .btrack{background:var(--c-2);border-radius:99px;height:9px;overflow:hidden}
  .bfill{display:block;height:100%;border-radius:99px;transition:width .3s}
  .bv{font-variant-numeric:tabular-nums;color:var(--muted);min-width:44px;text-align:right}

  .cols{position:relative;border-bottom:1px solid var(--line)}
  .col{position:absolute;bottom:0;border-radius:4px 4px 0 0;transform:translateX(-50%);
       transition:opacity .15s;min-height:2px}
  .col:hover{opacity:.7}
  .gl{position:absolute;left:0;right:0;border-top:1px dashed var(--line);pointer-events:none}
  .xax{display:flex;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
  .xax span{flex:1;text-align:center;overflow:hidden}
  .axmax{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}

  .funnel{display:grid;gap:9px}
  .fstep{display:grid;grid-template-columns:minmax(120px,38%) 1fr auto;align-items:center;
         gap:12px;font-size:13px}
  .fl{color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ftrack{background:var(--c-2);border-radius:var(--r-s);height:20px;overflow:hidden}
  .ffill{display:block;height:100%;border-radius:var(--r-s);background:var(--c1);transition:width .3s}
  .fv{font-variant-numeric:tabular-nums;color:var(--fg);min-width:64px;text-align:right}

  .tbl{margin-top:12px}
  .tbl summary{font-size:12.5px}
  .tbl table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px}
  .tbl th,.tbl td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
  .tbl th{color:var(--muted);font-weight:600}
  .tbl td{font-variant-numeric:tabular-nums}

  .flash{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
         background:var(--fg);color:var(--bg);padding:11px 18px;border-radius:99px;
         font-size:13.5px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9;
         max-width:90vw;text-align:center;box-shadow:var(--sh-m)}
  .flash.on{opacity:1}

  @media (max-width:1000px){ .grid.stats{grid-template-columns:repeat(2,1fr)} .grid.two{grid-template-columns:1fr} }
  @media (max-width:768px){
    .app{grid-template-columns:1fr}
    .rail{position:static;height:auto;flex-direction:row;overflow-x:auto;border-right:0;
          border-bottom:1px solid var(--line);padding:10px 12px;gap:4px;align-items:center}
    .brand,.foot,.newp{display:none}
    .psel{padding:0;margin:0;border:0;flex:none}
    .plab{display:none}
    .nav .n{margin-left:6px}
    .main{padding:18px 16px 90px}
    .row{grid-template-columns:1fr}
    .rmeta{align-items:flex-start;text-align:left}
    .rmeta .notes{width:100%}
    .grid.stats{grid-template-columns:1fr}
    .seg{margin-left:0;width:100%;overflow-x:auto}
  }
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>
<div class="app">
<nav class="rail">
  <div class="brand">${icon('glass')}<span>Leads</span></div>

  <label class="psel">
    <span class="plab">Profile</span>
    <select id="profile" aria-label="Switch profile">${options}</select>
  </label>

  ${item('/', 'today', 'Today', counts.todo || 0)}
  ${item('/sent', 'sent', 'Sent', counts.sent || 0)}
  ${item('/skipped', 'skipped', 'Skipped', counts.skipped || 0)}
  ${item('/bounced', 'bounced', 'Bounced', counts.bounced || 0)}
  ${item('/metrics', 'metrics', 'Metrics', 0)}
  ${item('/calendar', 'calendar', 'Calendar', 0)}

  <details class="newp">
    <summary>New profile</summary>
    <input id="pname" type="text" placeholder="What to call it" maxlength="80">
    <textarea id="pbrief" rows="4" placeholder="Who do you want to reach? Two sentences is enough — the trades, the size of business, and anything that would disqualify one."></textarea>
    <button id="pcreate" type="button" class="go sm">Create</button>
  </details>

  <div class="foot">
    <b>${counts.contacted || 0}</b> contacted all time<br>
    ${sending?.connected
      ? `<b>${esc(sending.sent_today)}/${esc(sending.daily_cap)}</b> sent today`
      : 'sending not connected'}
    ${signedInAs ? `<br>${esc(signedInAs)} &middot; <a href="/auth/logout">sign out</a>` : ''}
  </div>
</nav>
<main class="main">
${body}
</main>
</div>
<div class="flash" id="flash"></div>

<script nonce="${esc(nonce)}">
// No key here. The session cookie is sent automatically and the URL stays
// clean, so the credential is never in the address bar or in history.
const flash = (t) => {
  const f = document.getElementById('flash');
  f.textContent = t; f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 2600);
};
async function post(path, body){
  const r = await fetch(path, {
    method:'POST',
    headers: {'content-type':'application/json'},
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.error || ('request failed (' + r.status + ')'));
  return data;
}
const holder = (el) => el.closest('.card, .row');
const field = (el, name) => holder(el).querySelector('[data-field="' + name + '"]');

// The filter bar cannot be a <form>: the CSP sets form-action 'none' so that a
// hostile lead name can never become a submission target. Navigating by hand
// costs three lines and keeps that directive tight.
function go(changes){
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(changes)) {
    if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
  }
  if (!('page' in changes)) u.searchParams.delete('page');
  location.assign(u.pathname + u.search);
}

// Sending a note: the button, or Enter in the field. One path for both.
async function sendNote(el){
  const note = (el.value || '').trim();
  if (note.length < 4) { flash('Say what it got wrong'); el.focus(); return; }

  const card = holder(el);
  el.disabled = true;
  try {
    const res = await post('/api/entity/' + card.dataset.eid + '/correct', {note});
    let said;
    if (res.changed?.length) {
      said = 'Fixed ' + res.changed.join(' and ').replace(/_/g, ' ') + ' — rescoring';
      // Say so when the old name was also cleaned out of the emails, or the
      // Sent page appears to have ignored the correction until it reloads.
      if (res.renamed) said += ', renamed in ' + res.renamed +
        (res.renamed === 1 ? ' email' : ' emails');
    } else if (res.reranked) {
      // A judgement, not a correction. Say what it moved so it never looks
      // like nothing happened.
      said = 'Noted — score ' + res.reranked.from + ' → ' + res.reranked.to;
    } else {
      said = 'Noted — it will shape future scoring';
    }
    if (res.rejected?.length) said += ' (' + res.rejected[0] + ')';
    flash(said);
    el.value = '';
    setTimeout(()=>location.reload(), 1800);
  } catch(e){ el.disabled = false; flash(e.message); }
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.classList?.contains('npill')) {
    ev.preventDefault();
    sendNote(ev.target);
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.filter) return go({ [el.dataset.filter]: el.value });
  if (el.id === 'day') return go({ day: el.value });
  // Switching profile is switching account: drop every filter and land on the
  // same page of the other one, rather than carrying a search across.
  if (el.id === 'profile') {
    const u = new URL(location.href);
    location.assign(u.pathname + '?profile=' + encodeURIComponent(el.value));
  }
});

// Booking times arrive as UTC, because the Worker rendering them has no idea
// where the reader is. Rewritten here, once, in the browser that does know.
for (const t of document.querySelectorAll('time.t[datetime]')) {
  const d = new Date(t.getAttribute('datetime'));
  if (!isNaN(d)) t.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
for (const t of document.querySelectorAll('time.d[datetime]')) {
  const d = new Date(t.getAttribute('datetime') + 'T12:00:00Z');
  if (!isNaN(d)) {
    t.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
}

// A new profile. The model writes the categories, the keywords and the scoring
// brief from this one sentence; nothing here is code the person has to write.
const create = document.getElementById('pcreate');
if (create) create.addEventListener('click', async () => {
  const name = document.getElementById('pname');
  const brief = document.getElementById('pbrief');
  if ((brief.value || '').trim().length < 40) {
    flash('Say a little more about who you want to reach');
    brief.focus();
    return;
  }
  create.disabled = true;
  create.textContent = 'Working…';
  try {
    const res = await post('/api/profiles', { name: name.value, brief: brief.value });
    flash('Created — ' + (res.niches || []).length + ' categories, ' +
          res.seed_keywords + ' search terms');
    setTimeout(() => location.assign('/?profile=' + encodeURIComponent(res.slug)), 1500);
  } catch (e) {
    create.disabled = false;
    create.textContent = 'Create';
    flash(e.message);
  }
});

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if(!b) return;
  const card = holder(b);
  const id = card && card.dataset.oid;

  if(b.dataset.act === 'note'){
    return sendNote(b.closest('.notes').querySelector('.npill'));
  }
  if(b.dataset.page) return go({ page: b.dataset.page });
  if(b.dataset.act === 'clear') return go({ q:'', from:'', to:'' });

  if(b.dataset.copy){
    await navigator.clipboard.writeText(card.querySelector('.mail').textContent.trim());
    b.textContent = 'Copied';
    setTimeout(()=>{ b.textContent = 'Copy email'; }, 1800);
    return;
  }
  if(b.dataset.open){
    const d = card.querySelector('[data-drawer="' + b.dataset.open + '"]');
    d.classList.add('open');
    const f = d.querySelector('textarea, input');
    if(f) f.focus();
    return;
  }
  if(b.dataset.act === 'cancel'){ b.closest('.drawer').classList.remove('open'); return; }

  if(b.dataset.act === 'save'){
    b.disabled = true;
    try {
      const res = await post('/api/outreach/' + id + '/edit', {
        subject: field(b, 'subject').value,
        body: field(b, 'body').value,
      });
      flash(res.footer_restored ? 'Saved — the opt-out and address were put back' : 'Saved');
      setTimeout(()=>location.reload(), 900);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'send'){
    b.disabled = true; b.textContent = 'Sending…';
    try {
      const res = await post('/api/send/' + id);
      flash('Sent to ' + res.to);
      setTimeout(()=>location.reload(), 700);
    } catch(e){
      b.disabled = false; b.textContent = 'Send it';
      flash('Not sent — ' + e.message);
    }
    return;
  }
  if(b.dataset.act === 'sent'){
    b.disabled = true;
    try { await post('/api/decide/' + id, {decision:'SENT'}); location.reload(); }
    catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'bounce'){
    const note = (field(b, 'note').value || '').trim();
    if(note.length < 4){ field(b, 'note').focus(); flash('What did the bounce say?'); return; }
    b.disabled = true;
    try {
      await post('/api/outreach/' + id + '/bounce', {note});
      flash('Address dropped — the business stays on the list');
      setTimeout(()=>location.reload(), 900);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'setemail'){
    const email = (field(b, 'email').value || '').trim();
    b.disabled = true;
    try {
      await post('/api/entity/' + card.dataset.eid + '/email', {email});
      flash('Address saved');
      setTimeout(()=>location.reload(), 700);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'status'){
    b.disabled = true;
    try {
      await post('/api/entity/' + card.dataset.eid + '/status', {status: b.dataset.status});
      flash(b.dataset.status ? 'Marked ' + b.dataset.status.toLowerCase().replace('_',' ') : 'Status cleared');
      setTimeout(()=>location.reload(), 600);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'revive'){
    b.disabled = true;
    try {
      await post('/api/outreach/' + id + '/revive');
      flash('Back in today’s queue');
      setTimeout(()=>location.assign('/'), 800);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'skip' || b.dataset.act === 'block'){
    const ta = field(b, 'reason');
    const reason = (ta.value || '').trim();
    if(reason.length < 4){ ta.focus(); flash('Please say why — that is what teaches it'); return; }
    b.disabled = true;
    try {
      await post('/api/decide/' + id, {decision: b.dataset.act === 'block' ? 'BLOCKED' : 'SKIPPED', reason});
      location.reload();
    } catch(e){ b.disabled = false; flash(e.message); }
  }
});
</script>
</body></html>`;
}


const trim = (s) => String(s || '').split(' | ')[0].slice(0, 160);
const short = (s) => String(s || '').slice(0, 10);
function safe(s) { try { return JSON.parse(s); } catch { return null; } }
