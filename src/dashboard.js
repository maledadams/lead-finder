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

import { NICHES } from './config.js';
import { renderMetrics } from './metrics.js';

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
};

export async function renderDashboard(db, env, opts = {}) {
  const {
    view = 'today', nonce = '', signedInAs = null, sending = null,
    day, page = 1, q = '', from = null, to = null,
  } = opts;

  const counts = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM outreach WHERE queue_date = ? AND status = 'DRAFT') AS todo,
       (SELECT COUNT(*) FROM outreach WHERE status = 'SENT')                     AS sent,
       (SELECT COUNT(*) FROM outreach WHERE status = 'SKIPPED')                  AS skipped,
       (SELECT COUNT(*) FROM outreach WHERE status = 'BOUNCED')                  AS bounced,
       (SELECT COUNT(*) FROM entities WHERE state = 'CONTACTED')                 AS contacted`
  ).bind(day).first() || {};

  const body = view === 'today'
    ? await todayView(db, day, sending)
    : view === 'metrics'
      ? await renderMetrics(db, env, { period: opts.period || 'month' })
      : await historyView(db, view, { page, q, from, to });

  return shell({ view, nonce, signedInAs, sending, counts, body });
}

// ---------------------------------------------------------------------------
// Today — the work itself.
// ---------------------------------------------------------------------------

async function todayView(db, day, sending) {
  const [queue, lessons, recent] = await Promise.all([
    db.prepare(
      `SELECT o.id AS oid, o.rank, o.subject, o.body, o.status, o.persona, o.edited_at,
              e.id AS eid, e.display_name, e.website, e.domain, e.instagram,
              e.phone, e.contact_email, e.score, e.niche, e.location_text,
              e.website_opportunity, e.system_opportunity, e.power_signals,
              e.personalization, e.has_website
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.queue_date = ? ORDER BY o.rank ASC`
    ).bind(day).all(),
    db.prepare('SELECT lesson, kind, weight FROM lessons WHERE active = 1 ORDER BY weight DESC LIMIT 6').all(),
    db.prepare(
      `SELECT f.decision, f.reason, e.display_name FROM feedback f
       JOIN entities e ON e.id = f.entity_id
       WHERE f.reason IS NOT NULL ORDER BY f.created_at DESC LIMIT 4`
    ).all(),
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

${todo.length ? todo.map((r) => card(r, canSend)).join('') : `<div class="empty">
  <b>Nothing to review right now.</b><br>
  New leads are found overnight and appear here each morning.
</div>`}

${done.length ? `<h2>Already handled today</h2>${done.map((r) => card(r, canSend)).join('')}` : ''}

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

function card(r, CAN_SEND = false) {
  const p = safe(r.personalization) || {};
  const power = safe(r.power_signals) || [];
  const niche = NICHES[r.niche]?.label || 'Creative business';
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
    ${r.contact_email ? `<span class="dim">${esc(r.contact_email)}</span>` : '<span class="warn">no address on file</span>'}
  </div>

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

async function historyView(db, view, { page, q, from, to }) {
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

  const where = ['o.status = ?'];
  const args = [status];
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
    ${view === 'skipped' && r.reason ? `<div class="why sm"><b>Reason:</b> ${esc(r.reason)}</div>` : ''}
    ${view === 'bounced' && r.send_error ? `<div class="why sm"><b>Bounce:</b> ${esc(r.send_error)}</div>` : ''}
    ${view === 'bounced' ? bouncedContact(r) : ''}
    <details>
      <summary>The email</summary>
      <div class="mail">${esc(r.body)}</div>
    </details>
    ${rowActions(r, view)}
  </div>
  <div class="rmeta">
    <div class="when">${esc(short(when))}</div>
    ${view === 'sent' && r.sent_via ? `<div class="dim sm">via ${esc(r.sent_via)}</div>` : ''}
    ${view === 'sent' && r.contact_email ? `<div class="dim sm">${esc(r.contact_email)}</div>` : ''}
  </div>
</div>`;
}

/** On a bounced lead the address is gone. This is how a new one gets in. */
function bouncedContact(r) {
  if (r.contact_email) {
    return `<div class="why sm"><b>New address:</b> ${esc(r.contact_email)} —
      put it back in the queue to send.</div>`;
  }
  return `<div class="drawer open" data-drawer="email">
    <label class="lb" for="e-${esc(r.oid)}">A corrected address, if you found one</label>
    <input id="e-${esc(r.oid)}" data-field="email" type="email" placeholder="hello@theirdomain.com">
    <div class="acts"><button data-act="setemail">Save address</button></div>
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
function shell({ view, nonce, signedInAs, sending, counts, body }) {
  const item = (href, key, label, n) =>
    `<a class="nav" href="${href}"${view === key ? ' aria-current="page"' : ''}>${esc(label)}${
      n ? `<span class="n">${n}</span>` : ''}</a>`;

  return `<!doctype html>
<html lang="en" data-theme="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PGNpcmNsZSBjeD0nMTQnIGN5PScxNCcgcj0nOC41JyBmaWxsPSdub25lJyBzdHJva2U9JyMwMDZGRUUnIHN0cm9rZS13aWR0aD0nMy4yJy8+PHBhdGggZD0nTTIwLjQgMjAuNCAyNyAyNycgc3Ryb2tlPScjMDA2RkVFJyBzdHJva2Utd2lkdGg9JzMuNicgc3Ryb2tlLWxpbmVjYXA9J3JvdW5kJy8+PC9zdmc+">
<title>${esc(TITLES[view] || 'Leads')} — leads</title>
<script nonce="${esc(nonce)}">
// Before first paint, so a dark-mode user never sees a white flash.
try {
  var t = localStorage.getItem('lf-theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}
</script>
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
  .brand{display:flex;align-items:center;gap:9px;padding:2px 10px 16px;font-weight:700;
         letter-spacing:-.02em;font-size:15px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none}
  .nav{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:var(--r-s);
       text-decoration:none;font-size:14px;white-space:nowrap;color:var(--muted);
       transition:background .15s,color .15s}
  .nav:hover{background:var(--c-2);color:var(--fg)}
  .nav[aria-current="page"]{background:var(--p50);color:var(--p600);font-weight:600}
  :root[data-theme="dark"] .nav[aria-current="page"]{background:rgba(0,111,238,.18);color:var(--p300)}
  .nav .n{margin-left:auto;font-size:12px;font-variant-numeric:tabular-nums;
          background:var(--c-2);color:var(--muted);padding:1px 7px;border-radius:99px}
  .nav[aria-current="page"] .n{background:var(--p100);color:var(--p700)}
  :root[data-theme="dark"] .nav[aria-current="page"] .n{background:rgba(0,111,238,.3);color:var(--p200)}
  .foot{margin-top:auto;padding:12px 11px 0;font-size:12px;color:var(--muted);line-height:1.6;
        border-top:1px solid var(--line)}
  .foot b{font-variant-numeric:tabular-nums;color:var(--fg)}
  .tog{margin:10px 0 0;width:100%;justify-content:center}

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
  .mail{background:var(--c-2);border-radius:var(--r-m);padding:14px;white-space:pre-wrap;
        font-size:13.5px;line-height:1.65;margin-top:8px;max-width:68ch}

  .rows{border-top:1px solid var(--line);margin-top:18px}
  .row{display:grid;grid-template-columns:1fr auto;gap:6px 20px;padding:15px 4px;
       border-bottom:1px solid var(--line)}
  .rmain{min-width:0} .subj{margin-top:2px}
  .rmeta{text-align:right;white-space:nowrap}
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

  .drawer{display:none;margin-top:12px}
  .drawer.open{display:block}
  .drawer input,.drawer textarea{width:100%;max-width:68ch;font:inherit;font-size:13.5px;
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
    .brand,.foot{display:none}
    .nav .n{margin-left:6px}
    .tog{margin:0 0 0 auto;width:auto}
    .main{padding:18px 16px 90px}
    .row{grid-template-columns:1fr} .rmeta{text-align:left}
    .grid.stats{grid-template-columns:1fr}
    .seg{margin-left:0;width:100%;overflow-x:auto}
  }
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>
<div class="app">
<nav class="rail">
  <div class="brand"><span class="dot"></span>Leads</div>
  ${item('/', 'today', 'Today', counts.todo || 0)}
  ${item('/sent', 'sent', 'Sent', counts.sent || 0)}
  ${item('/skipped', 'skipped', 'Skipped', counts.skipped || 0)}
  ${item('/bounced', 'bounced', 'Bounced', counts.bounced || 0)}
  ${item('/metrics', 'metrics', 'Metrics', 0)}
  <button class="tog" id="theme" type="button" aria-label="Switch between light and dark">
    <span id="themelabel">Dark</span>
  </button>
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

// Light is the default; dark is a choice this browser remembers.
const label = document.getElementById('themelabel');
const paint = () => { label.textContent =
  document.documentElement.dataset.theme === 'dark' ? 'Light' : 'Dark'; };
paint();
document.getElementById('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('lf-theme', next); } catch (e) {}
  paint();
});

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

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.filter) return go({ [el.dataset.filter]: el.value });
  if (el.id === 'day') return go({ day: el.value });
});

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if(!b || b.id === 'theme') return;
  const card = holder(b);
  const id = card && card.dataset.oid;

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
