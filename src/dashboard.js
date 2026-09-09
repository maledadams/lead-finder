// Oliver's working tool.
//
// This is not a stats page. One person opens it each morning, works down a
// list, and for each business decides: send this, or don't — and says why.
// That "why" is the most valuable output of the whole system, because it is
// what teaches the scoring which businesses this operation actually wants.
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
import { confirmDialog, esc, icon, settingsDialog } from './ui.js';
import { docEditor, docPage, docsIndex, docsRail, folderPage } from './docsview.js';

/**
 * What a brand-new install sees.
 *
 * A database with no profile is not an error, it is the first run. Rather than
 * shipping somebody else's categories and copy in the schema, the system starts
 * empty and asks one question — everything else is written from the answer.
 *
 * Deliberately its own page rather than a panel in Settings: there is nothing
 * else to look at yet, and hiding the only thing you can do behind a menu is a
 * poor way to greet anyone.
 */
export function setupPage(env, nonce) {
  const missing = ['SENDER_NAME', 'SENDER_EMAIL', 'SENDER_POSTAL_ADDRESS']
    .filter((k) => !env?.[k]);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Set up — leads</title>
<style>
  :root{--bg:#FFFFFF;--fg:#11181C;--c-2:#f4f4f5;--line:#e4e4e7;--muted:#52525b;
        --accent:#006FEE;--accent-ink:#fff;--warn:#936316;--r:12px}
  @media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#ECEDEE;--c-2:#18181b;
        --line:#27272a;--muted:#a1a1aa}}
  *{box-sizing:border-box}
  /* The same trap as the closed dialog: [hidden] is only a UA rule, so any
     author rule setting display beats it and the element stays on screen. The
     confirm dialog's typed-name field appeared on every delete because of
     exactly that. One !important protects every use of hidden. */
  [hidden]{display:none!important}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  main{max-width:44rem;margin:12vh auto;padding:0 1.4rem}
  h1{font-size:24px;letter-spacing:-.02em;margin:0 0 6px}
  p{color:var(--muted);max-width:60ch}
  label{display:block;font-size:13px;color:var(--muted);margin:18px 0 5px}
  input,textarea{width:100%;font:inherit;font-size:15px;padding:11px 13px;border-radius:var(--r);
       border:1px solid var(--line);background:var(--c-2);color:var(--fg);resize:vertical}
  button{font:inherit;font-size:15px;font-weight:600;padding:11px 20px;border-radius:var(--r);
       border:0;background:var(--accent);color:var(--accent-ink);cursor:pointer;margin-top:18px}
  button:disabled{opacity:.5}
  .warn{border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));
        background:color-mix(in srgb,var(--warn) 8%,transparent);
        border-radius:var(--r);padding:12px 15px;margin:20px 0;font-size:13.5px}
  code{background:var(--c-2);padding:1px 6px;border-radius:5px;font-size:13px}
  .out{margin-top:20px;font-size:14px}
</style></head><body><main>
  <h1>Set up your first profile</h1>
  <p>This install has no profile yet, so it has no categories, no email copy and
     no scoring brief. Describe who you want to reach and all three are written
     from that — you do not configure them by hand, and nothing here came from
     anybody else.</p>

  ${missing.length ? `<div class="warn"><b>Set these first, or drafts cannot be sent:</b><br>
    ${missing.map((k) => `<code>${k}</code>`).join(' ')}<br>
    They live in <code>wrangler.toml</code> and the postal address is required by
    CAN-SPAM in every email you send.</div>` : ''}

  <label for="name">What should this profile be called?</label>
  <input id="name" type="text" maxlength="80" placeholder="Independent makers" autofocus>

  <label for="brief">Who do you want to reach?</label>
  <textarea id="brief" rows="5" placeholder="Two or three sentences. The kind of business, roughly what size, where they are, and anything that would rule one out."></textarea>

  <button id="go">Create it</button>
  <div class="out" id="out"></div>
</main>
<script nonce="${esc(nonce)}">
const out = document.getElementById('out');
const go = document.getElementById('go');
go.addEventListener('click', async () => {
  const name = document.getElementById('name').value;
  const brief = document.getElementById('brief').value;
  if (brief.trim().length < 40) { out.textContent = 'Say a little more about who you want to reach.'; return; }
  go.disabled = true; out.textContent = 'Writing the categories, the copy and the scoring brief…';
  try {
    const r = await fetch('/api/setup', {
      method: 'POST', headers: {'content-type':'application/json'},
      credentials: 'same-origin', body: JSON.stringify({name, brief}),
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || 'setup failed');
    out.textContent = 'Done — ' + (d.niches || []).length + ' categories and ' +
      d.seed_keywords + ' search terms. Opening the dashboard…';
    setTimeout(() => location.assign('/'), 1400);
  } catch (e) { go.disabled = false; out.textContent = e.message; }
});
</script></body></html>`;
}

// Twenty a page, everywhere that lists entries. Also the cheapest single
// optimisation here: a history page reads 60% fewer rows than it did at fifty.
const PER_PAGE = 20;

/**
 * Their website and their Instagram, wherever a business appears.
 *
 * Icon plus word rather than icon alone: a globe on its own is guessable, and
 * these are links a person clicks in a hurry. The label carries the meaning and
 * the icon makes it findable.
 */
function siteLinks(r) {
  return `${r.website
    ? `<a class="ext" href="${esc(r.website)}" target="_blank" rel="noopener noreferrer">${
        icon('globe')}<span>Their website</span></a>`
    : ''}${r.instagram
    ? `<a class="ext" href="https://instagram.com/${esc(r.instagram)}" target="_blank" rel="noopener noreferrer">${
        icon('instagram')}<span>Instagram</span></a>`
    : ''}`;
}


const TITLES = {
  today: 'Today',
  sent: 'Sent',
  skipped: 'Skipped',
  bounced: 'Bounced',
  metrics: 'Metrics',
  calendar: 'Calendar',
  docs: 'Documentation',
};


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

  const body = view === 'docs'
    ? opts.docsBody
    : view === 'calendar'
      ? calendarView(opts.calendar, env)
      : view === 'today'
        ? await todayView(db, pid, day, sending, profile)
        : view === 'metrics'
          ? await renderMetrics(db, env, { period: opts.period || 'month', profile, day: opts.metricDay })
          : await historyView(db, pid, view, { page, q, from, to }, profile);

  // The settings sheet is on every page, so its categories are read once here.
  const [cats, geo] = await Promise.all([
    db.prepare('SELECT * FROM skip_categories WHERE profile_id = ? ORDER BY position, name')
      .bind(pid).all(),
    db.prepare(`SELECT * FROM regions WHERE profile_id IS NULL OR profile_id = ?
                ORDER BY kind, priority DESC, name`).bind(pid).all(),
  ]);

  return shell({
    view, nonce, signedInAs, sending, counts, body, profile, profiles, env,
    categories: cats.results || [],
    regions: geo.results || [],
    metroCount: opts.metroCount || 0,
    docsTree: opts.docsTree || null,
    docsSlug: opts.docsSlug || null,
  });
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
    ${siteLinks(r)}
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
      <button class="no" data-act="skip" disabled>Skip this one</button>
      <button data-act="block" disabled>Never contact them</button>
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
      <button class="no" data-act="bounce" disabled>Mark it bounced</button>
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
    where.push('(e.display_name LIKE ? OR o.subject LIKE ? OR e.location_text LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
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
            e.id AS eid, e.display_name, e.domain, e.website, e.instagram, e.location_text,
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

  // Somewhere for the search box to get its suggestions. A native <datalist>
  // means the browser does the matching, so this costs one capped query and no
  // JavaScript at all.
  const { results: places } = await db.prepare(
    `SELECT DISTINCT location_text FROM entities
     WHERE profile_id = ? AND location_text IS NOT NULL AND location_text <> ''
     ORDER BY location_text LIMIT 200`
  ).bind(pid).all();

  return `
<div class="head">
  ${view === 'skipped'
    ? `<button class="lead" data-act="open-categories">${icon('skipped')}<span>Categories</span></button>`
    : ''}
  <h1>${esc(TITLES[view])}</h1>
  <span class="dim sm">${total} in total</span>
</div>

<div class="filters">
  <div class="fq">
    <label class="lb" for="q">Search</label>
    <input id="q" type="search" value="${esc(q)}" list="places" data-filter="q"
           placeholder="business, subject or location" autocomplete="off">
    <datalist id="places">${
      (places || []).map((r) => `<option value="${esc(r.location_text)}">`).join('')
    }</datalist>
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
  return `<span class="notes"><span class="nlab">Notes<span class="opt">(optional)</span></span><input class="npill"
      data-field="correction" placeholder="optional — what did it get wrong?" maxlength="200"
      autocomplete="off" aria-label="Correct this record (optional)"><button class="nsend"
      data-act="note" title="Optional. Send a correction or a judgement">Send note</button></span>`;
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
      ${siteLinks(r)}
      ${r.contact_email ? `<span class="dim">${esc(r.contact_email)}</span>` : '<span class="warn">no address on file</span>'}
      <button class="link" data-open="email">${r.contact_email ? 'change' : 'add an address'}</button>
    </div>
    ${emailDrawer(r)}
    ${view === 'skipped' && r.reason ? `<div class="why sm"><b>Reason:</b> ${esc(r.reason)}</div>` : ''}
    ${view === 'bounced' && r.send_error ? `<div class="why sm"><b>Bounce:</b> ${esc(r.send_error)}</div>` : ''}
  </div>
  <div class="rmeta">
    <div class="when">${esc(short(when))}</div>
    ${view === 'sent' && r.sent_via ? `<div class="dim sm">via ${esc(r.sent_via)}</div>` : ''}
    ${view === 'sent' && r.contact_email ? `<div class="dim sm">${esc(r.contact_email)}</div>` : ''}
  </div>
  <details class="wide">
    <summary>The email</summary>
    <div class="mail">${esc(r.body)}</div>
  </details>
  ${rowActions(r, view)}
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
      ${noteControl()}
    </div>${bounceDrawer()}`;
  }
  if (view === 'skipped') {
    return `<div class="acts">
      <button data-act="revive">Edit &amp; put back in the queue</button>
      ${noteControl()}
    </div>`;
  }
  // bounced: only offer the requeue once there is somewhere to send it.
  return `<div class="acts">
    <button data-act="revive"${r.contact_email ? '' : ' disabled'}>Edit &amp; put back in the queue</button>
    ${r.contact_email ? '' : '<span class="dim sm">needs an address first</span>'}
    ${noteControl()}
  </div>`;
}

function emptyFor(view, filtered) {
  if (filtered) return '<b>Nothing matches those filters.</b><br>Try clearing them.';
  if (view === 'sent') return '<b>No emails sent yet.</b><br>They appear here once you send one from Today.';
  if (view === 'skipped') return '<b>Nothing skipped yet.</b><br>Skipped leads and your reasons collect here.';
  return '<b>No bounces.</b><br>Addresses that turn out to be dead show up here.';
}

/**
 * Numbered pagination.
 *
 * First and last are always reachable, the current page keeps two neighbours,
 * and the gaps collapse to an ellipsis — so a hundred pages still fit on one
 * line. A real <nav> with aria-current, because "page 6 of 100" is the kind of
 * thing a screen reader has to be able to say.
 */
export function pageNumbers(current, pages, span = 2) {
  const want = new Set([1, pages]);
  for (let n = current - span; n <= current + span; n++) {
    if (n >= 1 && n <= pages) want.add(n);
  }
  const sorted = [...want].sort((a, b) => a - b);
  const out = [];
  let previous = 0;
  for (const n of sorted) {
    // A gap standing in for exactly one page hides something clickable behind
    // an ellipsis that is not. Show the page instead — it is the same width.
    if (previous && n - previous === 2) out.push(previous + 1);
    else if (previous && n - previous > 2) out.push('gap');
    out.push(n);
    previous = n;
  }
  return out;
}

function pager(current, pages) {
  if (pages <= 1) return '';
  const step = (n, label, on) => on
    ? `<button data-page="${n}">${esc(label)}</button>`
    : `<button disabled>${esc(label)}</button>`;

  const numbers = pageNumbers(current, pages).map((n) => n === 'gap'
    ? '<span class="gap" aria-hidden="true">&hellip;</span>'
    : (n === current
      ? `<span class="pnum on" aria-current="page">${n}</span>`
      : `<button class="pnum" data-page="${n}" aria-label="Go to page ${n}">${n}</button>`)
  ).join('');

  return `<nav class="pager" aria-label="Pagination">
    ${step(current - 1, 'Previous', current > 1)}
    <span class="pnums">${numbers}</span>
    ${step(current + 1, 'Next', current < pages)}
    <span class="dim vh">Page ${current} of ${pages}</span>
  </nav>`;
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
/**
 * What Settings contains, at this stage.
 *
 * Anything disruptive belongs in here rather than beside the work it disrupts:
 * creating a profile is not something to do by accident while reading a queue,
 * which is exactly what a form in the sidebar invites.
 */
/**
 * One category, collapsed to its name until you open it.
 *
 * The trash appears on hover AND on keyboard focus, and stays put on a touch
 * screen — a control that only exists while a mouse is over it is a control
 * some people simply do not have.
 */
function categoryRow(c) {
  return `<details class="cat" data-cid="${esc(c.id)}">
    <summary>
      <span class="cname">${esc(c.name)}</span>
      <span class="dim sm">${esc(String(c.keywords || '').split(',').filter(Boolean).length)} keywords</span>
      <button class="trash" data-act="del-category" data-cid="${esc(c.id)}"
              aria-label="Delete the category ${esc(c.name)}">${icon('trash')}</button>
    </summary>
    <label class="lb" for="cn-${esc(c.id)}">Name</label>
    <input id="cn-${esc(c.id)}" data-field="cat-name" type="text" maxlength="60" value="${esc(c.name)}">
    <label class="lb" for="cd-${esc(c.id)}">What puts a skip in here</label>
    <textarea id="cd-${esc(c.id)}" data-field="cat-definition" rows="3"
      placeholder="In your own words. This is what the sorting reads.">${esc(c.definition || '')}</textarea>
    <label class="lb" for="ck-${esc(c.id)}">Keywords, comma separated</label>
    <input id="ck-${esc(c.id)}" data-field="cat-keywords" type="text" value="${esc(c.keywords || '')}"
      placeholder="already great, nothing to build">
    <p class="hint">A reason containing one of these is filed here without asking
      the model at all — which is why adding the phrases you actually type makes
      this cost nothing.</p>
    <div class="acts"><button class="go" data-act="save-category" data-cid="${esc(c.id)}">Save</button></div>
  </details>`;
}

const safeJson = (v) => { try { return JSON.parse(v); } catch { return null; } };

function regionRow(r) {
  const dormant = r.kind === 'city' && r.country !== 'US' && !r.acknowledged_at;
  return `<div class="srow" data-rid="${esc(r.id)}">
    <div>
      <b>${esc(r.name)}</b>
      ${r.kind === 'block' ? '<span class="pill bounced">never crawl</span>' : ''}
      ${dormant ? '<span class="pill weak">waiting on the rules</span>' : ''}
      <div class="dim sm">${esc(r.slug)}${r.country && r.country !== '--' ? ` &middot; ${esc(r.country)}` : ''}</div>
    </div>
    <div class="srow-acts">
      ${r.kind === 'city' ? `<label class="lb vh" for="pri-${esc(r.id)}">Priority for ${esc(r.name)}</label>
        <input id="pri-${esc(r.id)}" class="pri" type="number" min="-10" max="10" step="1"
               value="${esc(r.priority)}" data-act="priority" data-rid="${esc(r.id)}"
               title="Higher is swept sooner">` : ''}
      <button class="trash" data-act="del-region" data-rid="${esc(r.id)}"
              aria-label="Remove ${esc(r.name)} from the list">${icon('trash')}</button>
    </div>
  </div>`;
}

function settingsPanels({ profile, profiles, sending, env, categories = [], regions = [], metroCount = 0 }) {
  const rows = (profiles.length ? profiles : [profile]).map((p) => `
    <details class="cat" data-pid="${esc(p.id)}" data-pname="${esc(p.name)}">
      <summary>
        <span class="cname">${esc(p.name)}</span>
        ${p.id === profile.id ? '<span class="pill">open now</span>' : ''}
        ${p.is_default ? '<span class="pill strong">default</span>' : ''}
        ${p.active ? '' : '<span class="pill weak">archived</span>'}
        <span class="dim sm">/${esc(p.slug)}</span>
      </summary>

      <label class="lb" for="pn-${esc(p.id)}">Name</label>
      <input id="pn-${esc(p.id)}" data-field="p-name" type="text" maxlength="80" value="${esc(p.name)}">

      <label class="lb">Daily allowance for this profile</label>
      <div class="quad">
        ${['fetch', 'ai', 'source', 'browser'].map((k) => `<div>
          <label class="lb sm" for="pb-${esc(p.id)}-${k}">${k}</label>
          <input id="pb-${esc(p.id)}-${k}" data-field="p-${k}" type="number" min="0" step="1"
                 value="${esc((safeJson(p.budgets) || {})[k] ?? '')}" placeholder="default">
        </div>`).join('')}
      </div>
      <p class="hint">Left blank, the deployment default applies. The daily SEND
        cap is not here on purpose — one mailbox has one reputation, so it is
        shared by every profile rather than counted per profile.</p>

      <div class="acts">
        <button class="go" data-act="save-profile" data-pid="${esc(p.id)}">Save</button>
        ${p.is_default ? '' : `<button data-act="make-default" data-pid="${esc(p.id)}">Make default</button>`}
        <a class="ext" href="/?profile=${encodeURIComponent(p.slug)}">Open it</a>
        <button data-act="archive-profile" data-pid="${esc(p.id)}" data-active="${p.active ? '0' : '1'}">
          ${p.active ? 'Archive' : 'Restore'}
        </button>
        <button class="danger" data-act="delete-profile" data-pid="${esc(p.id)}">Delete permanently</button>
      </div>
      <p class="hint">Archiving stops the crawl and hides it, and can be undone.
        Deleting cannot: it destroys the leads and the record of what was sent.</p>
    </details>`).join('');

  const cities = regions.filter((r) => r.kind === 'city');
  const blocks = regions.filter((r) => r.kind === 'block');

  return [
    {
      id: 'geography',
      label: 'Where to crawl',
      icon: 'globe',
      hint: `${metroCount.toLocaleString()} places are in rotation. The built-in list covers all fifty US states; anything you add here is swept first, and anything you block is never swept again.`,
      body: `
        <h3>Add a place</h3>
        <div class="pair">
          <div><label class="lb" for="rcity">City or town</label>
            <input id="rcity" type="text" placeholder="Savannah" maxlength="90"></div>
          <div><label class="lb" for="rcc">Country</label>
            <input id="rcc" type="text" value="US" maxlength="2" size="2"></div>
        </div>
        <div class="acts">
          <button id="addcity" class="go">Add city</button>
          <button id="addcountry">Import a whole country</button>
        </div>
        <p class="hint">Coordinates come from OpenStreetMap's geocoder, not from
          typing — a box a few kilometres off centre finds nothing and reports it
          as an empty town.</p>

        <div class="warn-box">
          <b>Outside the United States the rules change.</b>
          CAN-SPAM covers the US. The EU is GDPR, Canada is CASL — which requires
          consent <em>before</em> you send and fines per message. A non-US place is
          added but not crawled until you say you understand that.
        </div>

        ${cities.length ? `<h3>Added</h3><div class="srows">${cities.map(regionRow).join('')}</div>` : ''}
        ${blocks.length ? `<h3>Never crawl</h3><div class="srows">${blocks.map(regionRow).join('')}</div>` : ''}

        <h3>Block a place</h3>
        <label class="lb" for="rblock">Its name, as it appears in the list</label>
        <input id="rblock" type="text" placeholder="miami-fl">
        <div class="acts"><button id="blockplace" class="no">Never crawl this</button></div>
        <p class="hint">Blocking works on the built-in cities too, which is the
          only way "never crawl Miami again" can actually mean it.</p>`,
    },
    {
      id: 'categories',
      label: 'Skip categories',
      icon: 'skipped',
      hint: 'What the metrics page counts when it asks why you skipped things. Yours to define — nothing here is built in, including the four that came with it.',
      body: `<div class="cats">${categories.map(categoryRow).join('')
        || '<div class="empty"><b>No categories yet.</b><br>Add one below and your skips will sort themselves into it.</div>'}</div>
        <h3>New category</h3>
        <label class="lb" for="ncname">Name</label>
        <input id="ncname" type="text" maxlength="60" placeholder="Bad timing">
        <label class="lb" for="ncdef">What puts a skip in here</label>
        <textarea id="ncdef" rows="3" placeholder="A fine lead at the wrong moment — recently rebuilt, mid redesign, closed for the season."></textarea>
        <label class="lb" for="nckw">Keywords, comma separated</label>
        <input id="nckw" type="text" placeholder="just rebuilt, new site, later">
        <div class="acts">
          <button id="catcreate" class="go">Add category</button>
          <button data-act="resort">Re-sort every skip now</button>
        </div>
        <p class="hint">Editing a category re-sorts everything filed under the old
          definition, so the chart never quietly means something else than it did.</p>`,
    },
    {
      id: 'profiles',
      label: 'Profiles',
      icon: 'today',
      hint: 'Each profile is a separate operation. Switching one is switching account: leads, drafts, replies, lessons and metrics never mix.',
      body: `<div class="srows">${rows}</div>
        <h3>New profile</h3>
        <p class="cap">Describe who you want to reach. The categories, the search
          terms, the scoring brief and the email copy are written from this — you
          do not configure any of it by hand.</p>
        <label class="lb" for="pname">Name</label>
        <input id="pname" type="text" maxlength="80" placeholder="Medium businesses">
        <label class="lb" for="pbrief">Who do you want to reach?</label>
        <textarea id="pbrief" rows="4" placeholder="Two sentences is enough — the trades, the size of business, and anything that would disqualify one."></textarea>
        <div class="acts"><button id="pcreate" class="go">Create profile</button></div>`,
    },
    {
      id: 'sending',
      label: 'Sending',
      icon: 'sent',
      hint: 'One mailbox, one reputation — so the daily cap is shared by every profile rather than counted per profile.',
      body: `<div class="srows">
        <div class="srow"><div><b>Zoho</b><div class="dim sm">${
          sending?.connected ? 'connected' : 'not connected'}</div></div>
          <div class="srow-acts">${sending?.connected
            ? '<button data-act="refresh-signature">Refresh signature</button>'
            : '<a class="ext" href="/api/zoho/connect">Connect</a>'}</div></div>
        <div class="srow"><div><b>Sent today</b><div class="dim sm">${
          esc(sending?.sent_today ?? 0)} of ${esc(sending?.daily_cap ?? 30)}</div></div></div>
        <div class="srow"><div><b>Bounce label</b><div class="dim sm">${
          esc(env?.ZOHO_BOUNCE_LABEL || 'bounce')} — mail carrying this label is read on every cron tick</div></div></div>
      </div>`,
    },
  ];
}

function shell({ view, nonce, signedInAs, sending, counts, body, profile, profiles, env,
  categories, regions, metroCount, docsTree, docsSlug }) {
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
  /* The same trap as the closed dialog: [hidden] is only a UA rule, so any
     author rule setting display beats it and the element stays on screen. The
     confirm dialog's typed-name field appeared on every delete because of
     exactly that. One !important protects every use of hidden. */
  [hidden]{display:none!important}
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
  /* An outbound link: icon and label as one target, the icon in the accent so
     it reads as a link without the label having to be coloured. */
  .ext{display:inline-flex;align-items:center;gap:5px;text-decoration:none}
  .ext:hover span{text-decoration:underline;text-underline-offset:2px}
  .ext .ico{width:15px;height:15px;color:var(--accent)}

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
  /* Settings is a button, not a link, but it sits in the same list and must
     look identical. It also stays put when the rail switches to documentation. */
  button.nav{border:0;background:none;width:100%;font-size:14px;font-weight:400}
  button.nav:hover{background:var(--c-2);color:var(--fg)}
  .pinned{margin-top:4px}
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
  /* The rail does not go anywhere when you enter documentation — its contents
     slide sideways. Two panes on a track, one transform. The profile switcher
     and Settings sit outside it so they never move. */
  .track{flex:1;min-height:0;overflow:hidden;position:relative}
  .track .pane{position:absolute;inset:0;display:flex;flex-direction:column;gap:2px;
       overflow-y:auto;transition:transform .34s cubic-bezier(.16,1,.3,1),opacity .2s}
  .track .pane.docs{transform:translateX(100%);opacity:0}
  .rail[data-mode="docs"] .track .pane{transform:translateX(-100%);opacity:0}
  .rail[data-mode="docs"] .track .pane.docs{transform:translateX(0);opacity:1}
  .railhead{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
       font-weight:600;margin:12px 11px 6px}
  .nav.back{color:var(--muted);font-size:13px}
  .nav.back .ico{width:14px;height:14px}
  .nav.sub{font-size:13px;padding-left:22px}
  .nav.sub.on{background:var(--p50);color:var(--p600);font-weight:600}
  :root:not([data-theme="light"]) .nav.sub.on{background:rgba(0,111,238,.18);color:var(--p300)}
  .nav.new{color:var(--accent);margin-top:6px}
  .folderlink{font-style:italic;opacity:.85}
  .tree>summary{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:var(--r-s);
       cursor:pointer;font-size:14px;color:var(--muted);list-style:none}
  .tree>summary::-webkit-details-marker{display:none}
  .tree>summary:hover{background:var(--c-2);color:var(--fg)}
  .tree>summary .n{margin-left:auto;font-size:12px;color:var(--muted)}
  @media (prefers-reduced-motion:reduce){ .track .pane{transition:none} }

  /* ---- documentation ------------------------------------------------- */
  .tools{margin-left:auto;display:flex;gap:2px;align-items:center}
  .tool{display:inline-flex;align-items:center;justify-content:center;padding:6px;
        border:0;background:none;color:var(--muted);border-radius:var(--r-s);
        text-decoration:none;opacity:0;transition:opacity .15s,background .15s}
  .card:hover .tool,.head .tool,.card:focus-within .tool{opacity:1}
  .tool:hover{background:var(--c-2);color:var(--fg)}
  .tool.danger-ico:hover{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad)}
  @media (pointer:coarse){ .tool{opacity:1} }
  .crumb{font-size:12.5px;color:var(--muted);text-decoration:none;
         display:block;width:100%;margin-bottom:-6px}
  .folder .top{display:flex;align-items:center;gap:9px}
  .folder .top h3{margin:0}
  .folder .top h3 a{text-decoration:none}
  .doc-expand>summary{cursor:pointer;display:flex;gap:12px;align-items:baseline;padding:4px 0}
  .doc-expand>summary .dim{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .btn{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;padding:8px 15px;
       border-radius:var(--r-s);border:1px solid var(--line);background:var(--c-1);
       color:var(--fg);text-decoration:none;font-weight:500}
  .btn.go{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
  .pushright{margin-left:auto}
  .updated{margin-top:26px}

  /* Prose: a measure that can be read, which the rest of the app does not need. */
  .prose{max-width:70ch;font-size:14.5px;line-height:1.75}
  .prose h1,.prose h2,.prose h3{letter-spacing:-.015em;margin:1.6em 0 .5em;
       text-transform:none;color:var(--fg);font-weight:650}
  .prose h1{font-size:22px} .prose h2{font-size:17px} .prose h3{font-size:15px}
  .prose p,.prose li{margin:.7em 0}
  .prose ul,.prose ol{padding-left:1.3em}
  .prose code{background:var(--c-2);padding:1px 5px;border-radius:5px;font-size:.9em}
  .prose pre{background:var(--c-2);padding:14px 16px;border-radius:var(--r-m);overflow-x:auto}
  .prose pre code{background:none;padding:0}
  .prose blockquote{margin:1em 0;padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}
  .prose table{border-collapse:collapse;width:100%;font-size:13.5px}
  .prose th,.prose td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left}
  .prose hr{border:0;border-top:1px solid var(--line);margin:2em 0}
  .dead-link{color:var(--muted);text-decoration:line-through}

  .editor input,.editor select,.editor textarea{width:100%;font:inherit;font-size:14px;
       padding:9px 11px;border-radius:var(--r-s);border:1px solid var(--line);
       background:var(--c-2);color:var(--fg);margin-bottom:10px}
  .editor #d-title{font-size:19px;font-weight:650;letter-spacing:-.015em}
  .scope{border:1px solid var(--line);border-radius:var(--r-m);padding:10px 14px;margin:4px 0 12px}
  .check{display:inline-flex;align-items:center;gap:6px;font-size:13px;margin-right:14px}
  .check input{width:auto;margin:0}
  .iconpick{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:12px}
  .ipick input{position:absolute;opacity:0;width:0}
  .ipick span{display:inline-flex;padding:7px;border-radius:var(--r-s);color:var(--muted);
       border:1px solid transparent;cursor:pointer}
  .ipick input:checked+span{border-color:var(--accent);color:var(--accent);background:var(--p50)}
  .ipick input:focus-visible+span{box-shadow:var(--ring)}
  .mdbar{display:flex;gap:3px;align-items:center;flex-wrap:wrap;
       border:1px solid var(--line);border-bottom:0;border-radius:var(--r-s) var(--r-s) 0 0;
       padding:6px;background:var(--c-2)}
  .mdbar button{padding:5px 10px;font-size:13px;min-width:32px;justify-content:center;
       border-color:transparent;background:none}
  .mdbar .tabs{margin-left:auto;display:flex;gap:2px}
  .mdbar .tabs button.on{background:var(--c-1);font-weight:600}
  .mdbody{border-radius:0 0 var(--r-s) var(--r-s)!important;min-height:420px;
       font:13.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
  .preview{border:1px solid var(--line);border-top:0;border-radius:0 0 var(--r-s) var(--r-s);
       padding:18px 20px;min-height:420px;max-width:none}

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
  /* The email, then the buttons, each across the whole row. Inside the left
     column the email was being narrowed by the date beside it, and the buttons
     could not share a line with the note field. */
  .row>details.wide{grid-column:1/-1;margin:2px 0 0}
  .row>.acts,.row>.drawer{grid-column:1/-1}
  .row>.acts{margin-top:8px}
  .when{font-size:13px;font-variant-numeric:tabular-nums}
  .row .pill{margin-left:0}

  .filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:18px}
  .filters input{font:inherit;font-size:13.5px;padding:8px 11px;border-radius:var(--r-s);
    border:1px solid var(--line);background:var(--c-2);color:var(--fg)}
  /* Wide enough for a business name or "Portland, OR" without truncating. */
  .fq{flex:1;min-width:260px;max-width:420px}
  .fq input{width:100%}
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
  .notes{display:flex;align-items:center;gap:7px;margin-left:auto;flex:1;min-width:300px;max-width:560px}
  /* On a history row the notes belong at the right-hand end, as one group.
     Growing to fill made them start where the buttons stop, which is why they
     read as left-aligned no matter how much room was left over. */
  .row .notes{flex:0 1 auto;min-width:0;justify-content:flex-end}
  .row .npill{flex:1 1 250px;min-width:200px}
  .nlab{font-size:12.5px;color:var(--muted);white-space:nowrap}
  .opt{margin-left:4px;font-size:11px;opacity:.75}
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

  /* ---- sheets: settings and the confirm ------------------------------ */
  /* Native dialog, so the focus trap, Esc and the backdrop are the browser's
     job rather than three hundred lines of ours. */
  /* A closed dialog is hidden by the browser's own stylesheet — but ANY author
     rule setting display beats it, and the wide rule below sets display:flex,
     which did exactly that: settings rendered inline at the foot of every page,
     visible and inert. The extra element selector keeps this ahead of it
     whatever the source order. */
  /* While a dialog is open the page behind it must not scroll — a wheel over
     the backdrop was moving the list underneath, so closing the sheet left you
     somewhere else entirely. :has() rather than a JS flag on purpose: the
     confirm dialog opens ON TOP of settings, and a counter that restored scroll
     when the first one closed would unlock the page with a sheet still up.
     scrollbar-gutter keeps the layout from jumping as the bar disappears. */
  html{scrollbar-gutter:stable}
  html:has(dialog[open]){overflow:hidden}

  dialog.sheet:not([open]){display:none}
  .sheet{border:0;padding:0;background:var(--c-1);color:var(--fg);
         border-radius:var(--r-xl);box-shadow:var(--sh-m);max-height:86dvh}
  .sheet::backdrop{background:rgba(17,24,28,.45);backdrop-filter:blur(6px)}
  :root:not([data-theme="light"]) .sheet::backdrop{background:rgba(0,0,0,.6)}
  .sheet.wide{width:min(880px,94vw);height:min(620px,86dvh);display:flex;flex-direction:column}
  .sheet.ask{width:min(430px,94vw);padding:22px 24px 18px;
       overflow-y:auto;overscroll-behavior:contain}
  /* h2 is uppercase everywhere else, which reads as shouting in a dialog. */
  .sheet.ask h2{font-size:16px;margin:0 0 8px;letter-spacing:-.01em;
       text-transform:none;color:var(--fg);font-weight:650}
  .sheet.ask .body{font-size:13.5px;color:var(--muted);margin:0 0 14px;line-height:1.6}
  .sheet.ask .typed{display:block;margin:0 0 14px}
  .sheet.ask input{width:100%;font:inherit;font-size:13.5px;padding:9px 11px;
      border-radius:var(--r-s);border:1px solid var(--line);background:var(--c-2);color:var(--fg)}
  .acts.end{justify-content:flex-end;margin-top:0}
  /* Destructive: red text and border, never a solid red block. A filled button
     is the one the eye goes to, and this must not be the easy one to hit. */
  button.danger{border-color:var(--bad);color:var(--bad);background:none;font-weight:600}
  button.danger:hover:not(:disabled){background:color-mix(in srgb,var(--bad) 12%,transparent)}

  .shead{display:flex;align-items:center;gap:12px;padding:16px 18px;
         border-bottom:1px solid var(--line)}
  .shead h1{font-size:16px;margin:0}
  .x{margin-left:auto;border:0;background:none;font-size:20px;line-height:1;padding:4px 9px;color:var(--muted)}
  .sbody{display:grid;grid-template-columns:186px 1fr;flex:1;min-height:0}
  .snavs{border-right:1px solid var(--line);padding:12px 10px;display:flex;
         flex-direction:column;gap:2px;overflow-y:auto}
  .snav{border:0;background:none;justify-content:flex-start;width:100%;
        padding:8px 11px;font-size:13.5px;color:var(--muted);border-radius:var(--r-s)}
  .snav:hover{background:var(--c-2);color:var(--fg)}
  .snav.on{background:var(--p50);color:var(--p600);font-weight:600}
  :root:not([data-theme="light"]) .snav.on{background:rgba(0,111,238,.18);color:var(--p300)}
  .snav .ico{width:16px;height:16px}
  .spanes{overflow-y:auto;overscroll-behavior:contain;padding:18px 22px 26px}
  .spane h2{font-size:15px;margin:0 0 4px;text-transform:none;letter-spacing:-.01em;color:var(--fg)}
  .spane h3{margin:22px 0 4px}
  .spane .cap{margin-bottom:14px}
  .spane input,.spane textarea{width:100%;font:inherit;font-size:13.5px;padding:9px 11px;
      border-radius:var(--r-s);border:1px solid var(--line);background:var(--c-2);
      color:var(--fg);margin-bottom:8px;resize:vertical}
  .cat{border-bottom:1px solid var(--line);margin:0}
  .cat>summary{display:flex;align-items:center;gap:10px;padding:11px 2px;
       font-size:13.5px;color:var(--fg);list-style:none}
  .cat>summary::-webkit-details-marker{display:none}
  .cat>summary::before{content:'▸';color:var(--muted);font-size:11px;transition:transform .15s}
  .cat[open]>summary::before{transform:rotate(90deg)}
  .cat .cname{font-weight:600}
  .cat .dim{margin-left:auto}
  .cat[open]{padding-bottom:14px}
  /* Revealed by hover OR focus, and always present where there is no hover at
     all. A control that exists only under a mouse is a control some people
     cannot reach. */
  .trash{opacity:0;border:0;background:none;padding:5px;color:var(--bad);flex:none}
  .cat:hover .trash,.cat:focus-within .trash{opacity:1}
  .trash:hover{background:color-mix(in srgb,var(--bad) 12%,transparent)}
  .trash .ico{width:16px;height:16px}
  @media (pointer:coarse){ .trash{opacity:1} }

  /* The Categories button sits at the far left of the head, ahead of the title. */
  .head .lead{margin-right:2px}
  .head .lead .ico{width:15px;height:15px}

  .pair{display:grid;grid-template-columns:1fr 90px;gap:10px}
  .quad{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .quad .lb{text-transform:capitalize}
  @media (max-width:640px){ .quad{grid-template-columns:repeat(2,1fr)} }
  .pri{width:64px;text-align:center;font-variant-numeric:tabular-nums;margin:0!important}
  .warn-box{border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));
      background:color-mix(in srgb,var(--warn) 8%,transparent);
      border-radius:var(--r-m);padding:12px 14px;margin:14px 0;font-size:13px;line-height:1.6}
  .warn-box b{display:block;margin-bottom:3px}

  .srows{border-top:1px solid var(--line)}
  .srow{display:flex;align-items:center;gap:14px;padding:12px 2px;
        border-bottom:1px solid var(--line)}
  .srow-acts{margin-left:auto;display:flex;gap:8px;align-items:center;flex:none}
  .srow .pill{margin-left:6px}
  @media (max-width:640px){ .sbody{grid-template-columns:1fr}
    .snavs{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)} }

  .empty,.nodata{background:var(--c-2);border:1px dashed var(--line);border-radius:var(--r-l);
         padding:32px;text-align:center;color:var(--muted);margin-top:14px;font-size:13.5px}
  .empty b{color:var(--fg)}
  .panel{background:var(--c-1);border:1px solid var(--line);border-radius:var(--r-l);
         padding:14px 18px;box-shadow:var(--sh-s)}
  .lessons{margin:0;padding-left:18px} .lessons li{font-size:13.5px;margin:4px 0}
  .k{color:var(--muted);font-size:11.5px} .note{font-size:13.5px;margin:8px 0}
  .pager{display:flex;gap:10px;align-items:center;margin-top:22px;font-size:13.5px;flex-wrap:wrap}
  .pnums{display:flex;gap:4px;align-items:center}
  .pnum{min-width:34px;justify-content:center;padding:7px 9px;font-variant-numeric:tabular-nums}
  .pnum.on{display:inline-flex;align-items:center;justify-content:center;min-width:34px;
           padding:8px 9px;border-radius:var(--r-s);font-weight:650;
           background:var(--p50);color:var(--p600);font-variant-numeric:tabular-nums}
  :root:not([data-theme="light"]) .pnum.on{background:rgba(0,111,238,.18);color:var(--p300)}
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]) .pnum.on{background:rgba(0,111,238,.18);color:var(--p300)}
  }
  .pager .gap{color:var(--muted);padding:0 2px}
  /* Announced, never shown: the page numbers alone do not say "of 20". */
  .vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);
      white-space:nowrap}

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
<nav class="rail" data-mode="${view === 'docs' ? 'docs' : 'queue'}">
  <div class="brand">${icon('glass')}<span>Leads</span></div>

  <label class="psel">
    <span class="plab">Profile</span>
    <select id="profile" aria-label="Switch profile">${options}</select>
  </label>

  <div class="track">
   <div class="pane">

  ${item('/', 'today', 'Today', counts.todo || 0)}
  ${item('/sent', 'sent', 'Sent', counts.sent || 0)}
  ${item('/skipped', 'skipped', 'Skipped', counts.skipped || 0)}
  ${item('/bounced', 'bounced', 'Bounced', counts.bounced || 0)}
  ${item('/metrics', 'metrics', 'Metrics', 0)}
  ${item('/calendar', 'calendar', 'Calendar', 0)}
  <a class="nav" href="/docs${qs}"${view === 'docs' ? ' aria-current="page"' : ''}>${
    icon('doc')}<span>Documentation</span></a>

   </div>
   <div class="pane docs">
     ${docsTree ? docsRail(docsTree, docsSlug) : ''}
   </div>
  </div>

  <button class="nav pinned" data-act="open-settings" aria-haspopup="dialog">
    ${icon('settings')}<span>Settings</span>
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
<div class="flash" id="flash" role="status" aria-live="polite"></div>
${settingsDialog(settingsPanels({ profile, profiles, sending, env, categories, regions, metroCount }))}
${confirmDialog()}

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
// ---- the confirm dialog ---------------------------------------------------
//
// One implementation, used by everything destructive. Returns a promise so a
// caller reads as an await inside an if, rather than as a callback, and
// <dialog> supplies the focus trap, Esc and the backdrop for free.
const askEl = document.getElementById('confirm');
function askConfirm({ body = '', confirmLabel = 'Delete this', requireText = null } = {}) {
  const yes = document.getElementById('confirm-yes');
  const no = document.getElementById('confirm-no');
  const wrap = document.getElementById('confirm-typed');
  const input = document.getElementById('confirm-input');
  const opener = document.activeElement;

  document.getElementById('confirm-body').textContent = body;
  yes.textContent = confirmLabel;
  wrap.hidden = !requireText;
  input.value = '';

  // The typed-name guard. The button stays dead until the name matches exactly,
  // so this cannot be got past by hammering Enter.
  const gate = () => { yes.disabled = Boolean(requireText) && input.value.trim() !== requireText; };
  if (requireText) {
    document.getElementById('confirm-typed-label').textContent = 'Type ' + requireText + ' to confirm';
    input.addEventListener('input', gate);
  }
  gate();

  return new Promise((resolve) => {
    const done = (ok) => {
      askEl.close();
      input.removeEventListener('input', gate);
      // Focus goes back where it came from, or the page loses its place.
      if (opener && opener.focus) opener.focus();
      resolve(ok);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    // Esc and the backdrop both mean no.
    askEl.addEventListener('close', () => done(false), { once: true });
    askEl.showModal();
    no.focus();
  });
}

// ---- settings -------------------------------------------------------------
const settingsEl = document.getElementById('settings');
function openSettings(panel){
  settingsEl.showModal();
  if (panel) showPanel(panel);
}
function showPanel(id){
  for (const b of settingsEl.querySelectorAll('.snav')) {
    const on = b.dataset.panel === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const s of settingsEl.querySelectorAll('.spane')) s.hidden = s.id !== 'panel-' + id;
}
// Deep link, so another page can send you to one panel: /skipped#settings/categories
if (location.hash.startsWith('#settings')) {
  openSettings(location.hash.split('/')[1] || null);
}

const holder = (el) => el.closest('.card, .row');

// A button inside a drawer reads the field in ITS drawer, not the first one that
// happens to appear in the row. On the Sent page the optional notes pill sits
// above the bounce drawer and answered to the same name, so "Mark it bounced"
// was reading the empty notes box and refusing what you had just typed.
const field = (el, name) =>
  (el.closest('.drawer') || holder(el)).querySelector('[data-field="' + name + '"]');

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

// A drawer's buttons stay disabled until its box says something. The reason and
// the bounce notice are both required by the API, and a button that looks ready
// and then refuses you is worse than one that waits.
function gateDrawer(ta){
  const d = ta.closest('.drawer');
  if(!d) return;
  const ready = (ta.value || '').trim().length >= 4;
  for(const b of d.querySelectorAll('.acts button[data-act]')) b.disabled = !ready;
}
document.addEventListener('input', (ev) => {
  if(ev.target.matches('.drawer textarea[data-field="reason"], .drawer textarea[data-field="note"]')){
    gateDrawer(ev.target);
  }
});

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
  // Picking a date on metrics means that day, so it carries the period with it.
  if (el.id === 'metric-day') return go({ period: 'day', day: el.value });
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
// ---- the markdown editor --------------------------------------------------
//
// The toolbar wraps the selection; the textarea stays the document. Everything
// here works if the toolbar is ignored, which is what makes it usable by
// keyboard and what stops it being a second, worse source of truth.
const body = document.querySelector('[data-field="doc-body"]');
// The one character this file cannot contain literally: the whole client script
// lives inside a template literal, so a backtick here would end it.
const TICK = String.fromCharCode(96);
const WRAP = {
  bold: ['**', '**', 'bold text'],
  italic: ['*', '*', 'italic text'],
  code: [TICK, TICK, 'code'],
  h2: ['## ', '', 'Heading'],
  quote: ['> ', '', 'Quoted'],
  ul: ['- ', '', 'List item'],
  ol: ['1. ', '', 'List item'],
  link: ['[', '](https://)', 'link text'],
};

function applyMd(kind){
  const rule = WRAP[kind];
  if(!rule || !body) return;
  const [before, after, placeholder] = rule;
  // Like TICK above: the client script is inside a template literal, so a
  // backslash escape here is eaten before the browser ever sees it. A literal
  // newline in a string is a syntax error, and it broke every button on the
  // page — settings, profile switching, all of it.
  const NL = String.fromCharCode(10);
  const start = body.selectionStart;
  const end = body.selectionEnd;
  const chosen = body.value.slice(start, end) || placeholder;
  // Line prefixes go on every selected line; wrappers go around the selection.
  const made = after === ''
    ? chosen.split(NL).map((l) => before + l).join(NL)
    : before + chosen + after;
  body.setRangeText(made, start, end, 'select');
  body.focus();
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-md],[data-tab]');
  if(!b) return;
  if(b.dataset.md){ ev.preventDefault(); applyMd(b.dataset.md); return; }

  // Preview is rendered by the server with the same function that renders the
  // saved page, so there is exactly one markdown implementation in the system.
  const preview = document.getElementById('d-preview');
  const write = b.dataset.tab === 'write';
  for(const t of document.querySelectorAll('[data-tab]')) t.classList.toggle('on', t === b);
  if(write){ body.hidden = false; preview.hidden = true; return; }

  preview.hidden = false; body.hidden = true;
  preview.innerHTML = '<p class="dim">Rendering…</p>';
  try {
    const r = await fetch('/api/docs/preview', {
      method:'POST', headers:{'content-type':'application/json'},
      credentials:'same-origin', body: JSON.stringify({markdown: body.value}),
    });
    preview.innerHTML = (await r.json()).html || '';
  } catch(e){ preview.textContent = e.message; }
});

// ---- geography ------------------------------------------------------------
const addcity = document.getElementById('addcity');
const country = () => (document.getElementById('rcc').value || 'US').trim().toUpperCase();

async function afterCountryAdd(res){
  if (res.needs_acknowledgement) {
    // Configured but dormant. Nothing outside the US is swept until this is
    // answered, and answering it is recorded.
    const ok = await askConfirm({
      body: (res.compliance || 'Outside the United States, CAN-SPAM does not apply and local rules do.')
        + ' Nothing there will be crawled until you confirm you understand that.',
      confirmLabel: 'I understand — start crawling there',
    });
    if (ok) {
      await post('/api/regions/acknowledge', { country: res.country || country() });
      flash('Acknowledged — those places will be swept');
    } else {
      flash('Added, but dormant until you acknowledge the rules');
    }
  }
  setTimeout(()=>location.reload(), 1200);
}

if (addcity) addcity.addEventListener('click', async () => {
  const name = document.getElementById('rcity');
  if ((name.value || '').trim().length < 2) { flash('Name the place first'); name.focus(); return; }
  addcity.disabled = true; addcity.textContent = 'Looking it up…';
  try {
    const res = await post('/api/regions', { name: name.value, country: country() });
    flash('Added ' + res.name);
    await afterCountryAdd({ ...res, compliance: null });
  } catch(e){ flash(e.message); }
  addcity.disabled = false; addcity.textContent = 'Add city';
});

const addcountry = document.getElementById('addcountry');
if (addcountry) addcountry.addEventListener('click', async () => {
  const cc = country();
  if (cc.length !== 2) { flash('Give a two-letter country code, like CA'); return; }
  addcountry.disabled = true; addcountry.textContent = 'Importing…';
  try {
    const res = await post('/api/regions/country', { country: cc });
    flash('Added ' + res.added + ' cities in ' + cc);
    await afterCountryAdd(res);
  } catch(e){ flash(e.message); }
  addcountry.disabled = false; addcountry.textContent = 'Import a whole country';
});

const blockplace = document.getElementById('blockplace');
if (blockplace) blockplace.addEventListener('click', async () => {
  const el = document.getElementById('rblock');
  const slug = (el.value || '').trim();
  if (slug.length < 2) { flash('Name the place to block'); el.focus(); return; }
  if(!(await askConfirm({
    body: 'Never crawl "' + slug + '" again? This applies to the built-in cities too.',
    confirmLabel: 'Never crawl this',
  }))) return;
  try {
    await post('/api/regions/block', { slug, name: slug });
    flash('Blocked — it will not be swept again');
    setTimeout(()=>location.reload(), 900);
  } catch(e){ flash(e.message); }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.act !== 'priority') return;
  try {
    await fetch('/api/regions/' + el.dataset.rid, {
      method: 'PATCH', headers: {'content-type':'application/json'},
      credentials: 'same-origin', body: JSON.stringify({priority: el.value}),
    });
    flash('Priority saved');
  } catch(e){ flash(e.message); }
});

const catcreate = document.getElementById('catcreate');
if (catcreate) catcreate.addEventListener('click', async () => {
  const name = document.getElementById('ncname');
  if ((name.value || '').trim().length < 2) { flash('Give the category a name'); name.focus(); return; }
  catcreate.disabled = true;
  try {
    await post('/api/categories', {
      name: name.value,
      definition: document.getElementById('ncdef').value,
      keywords: document.getElementById('nckw').value,
    });
    flash('Category added');
    setTimeout(()=>location.reload(), 900);
  } catch(e){ catcreate.disabled = false; flash(e.message); }
});

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

  if(b.dataset.act === 'open-settings'){ openSettings(); return; }
  if(b.dataset.act === 'open-categories'){ openSettings('categories'); return; }

  if(b.dataset.act === 'save-category' || b.dataset.act === 'del-category'){
    const box = b.closest('.cat');
    if(b.dataset.act === 'del-category'){
      // Deleting a category never deletes the skips filed under it — they go
      // back to unsorted and are sorted again. Say so, so nobody hesitates.
      const name = box.querySelector('.cname').textContent;
      const ok = await askConfirm({
        body: 'The category "' + name + '" will be removed. The skips filed under it keep their reasons and are sorted again on the next pass.',
        confirmLabel: 'Delete this',
      });
      if(!ok) return;
      b.disabled = true;
      try {
        const r = await fetch('/api/categories/' + b.dataset.cid, {method:'DELETE', credentials:'same-origin'});
        if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || 'could not delete');
        flash('Category deleted — its skips will be sorted again');
        setTimeout(()=>location.reload(), 900);
      } catch(e){ b.disabled = false; flash(e.message); }
      return;
    }
    b.disabled = true;
    try {
      await post('/api/categories', {
        id: b.dataset.cid,
        name: box.querySelector('[data-field="cat-name"]').value,
        definition: box.querySelector('[data-field="cat-definition"]').value,
        keywords: box.querySelector('[data-field="cat-keywords"]').value,
      });
      flash('Saved — skips under the old definition will be sorted again');
      setTimeout(()=>location.reload(), 1100);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }

  if(b.dataset.act === 'save-doc'){
    const form = b.closest('.editor');
    const val = (n) => form.querySelector('[data-field="' + n + '"]');
    const title = val('doc-title');
    if((title.value || '').trim().length < 2){ flash('Give it a title'); title.focus(); return; }

    const chosen = [...form.querySelectorAll('[data-field="doc-profile"]:checked')].map((c) => c.value);
    const iconEl = form.querySelector('[data-field="doc-icon"]:checked');
    b.disabled = true;
    try {
      const res = await post('/api/docs', {
        id: form.dataset.did || undefined,
        title: title.value,
        body_md: val('doc-body') ? val('doc-body').value : '',
        parent_id: val('doc-parent').value || null,
        is_folder: val('doc-folder').value === '1',
        icon: iconEl ? iconEl.value : null,
        scope: chosen,
      });
      flash('Saved');
      setTimeout(()=>location.assign('/docs/' + res.slug), 600);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }

  if(b.dataset.act === 'del-doc'){
    const isFolder = b.dataset.folder === '1';
    const ok = await askConfirm({
      body: isFolder
        ? 'Deleting the folder "' + b.dataset.title + '" also deletes every page inside it. Export anything you want to keep first.'
        : 'The page "' + b.dataset.title + '" will be deleted.',
      confirmLabel: 'Delete this',
    });
    if(!ok) return;
    b.disabled = true;
    try {
      const r = await fetch('/api/docs/' + b.dataset.did, {method:'DELETE', credentials:'same-origin'});
      const d = await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d.error || 'could not delete');
      flash('Deleted' + (d.children ? ' with ' + d.children + ' page(s) inside' : ''));
      setTimeout(()=>location.assign('/docs'), 800);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }

  if(b.dataset.act === 'save-profile'){
    const box = b.closest('.cat');
    const num = (k) => {
      const v = box.querySelector('[data-field="p-' + k + '"]').value.trim();
      return v === '' ? undefined : Number(v);
    };
    b.disabled = true;
    try {
      const r = await fetch('/api/profiles/' + b.dataset.pid, {
        method:'PATCH', headers:{'content-type':'application/json'}, credentials:'same-origin',
        body: JSON.stringify({
          name: box.querySelector('[data-field="p-name"]').value,
          budgets: {fetch:num('fetch'), ai:num('ai'), source:num('source'), browser:num('browser')},
        }),
      });
      const d = await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d.error || 'could not save');
      flash('Saved');
      setTimeout(()=>location.reload(), 900);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }

  if(b.dataset.act === 'archive-profile'){
    const on = b.dataset.active === '1';
    if(!on && !(await askConfirm({
      body: 'Archiving stops this profile crawling and hides it from the switcher. Nothing is deleted, and you can restore it here.',
      confirmLabel: 'Archive it',
    }))) return;
    b.disabled = true;
    try {
      await post('/api/profiles/' + b.dataset.pid + '/archive', {active: on});
      flash(on ? 'Restored' : 'Archived — nothing was deleted');
      setTimeout(()=>location.reload(), 900);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }

  if(b.dataset.act === 'delete-profile'){
    const box = b.closest('.cat');
    const name = box.dataset.pname;
    // Count first. "Are you sure?" is a question nobody can answer well;
    // "this deletes 1,958 leads and 157 sent emails" is.
    let f = {};
    try {
      const r = await fetch('/api/profiles/' + b.dataset.pid + '/footprint', {credentials:'same-origin'});
      f = await r.json();
    } catch(e){ /* the dialog still warns, just without the numbers */ }

    const ok = await askConfirm({
      body: 'This permanently deletes ' + (f.leads ?? '?') + ' leads and ' +
            (f.sent ?? '?') + ' sent emails, along with every decision and lesson ' +
            'this profile learned. It cannot be undone. Archiving instead keeps all of it.',
      confirmLabel: 'Delete this',
      requireText: name,
    });
    if(!ok) return;

    b.disabled = true;
    try {
      const r = await fetch('/api/profiles/' + b.dataset.pid, {
        method:'DELETE', headers:{'content-type':'application/json'}, credentials:'same-origin',
        body: JSON.stringify({confirm_name: name}),
      });
      const d = await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d.error || 'could not delete');
      flash('Deleted ' + d.deleted + ' — ' + d.leads + ' leads released');
      setTimeout(()=>location.assign('/'), 1400);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }

  if(b.dataset.act === 'del-region'){
    const row = b.closest('.srow');
    const name = row.querySelector('b').textContent;
    if(!(await askConfirm({
      body: 'Remove "' + name + '" from the list? Leads already found there are kept — this only stops it being swept again.',
      confirmLabel: 'Delete this',
    }))) return;
    b.disabled = true;
    try {
      const r = await fetch('/api/regions/' + b.dataset.rid, {method:'DELETE', credentials:'same-origin'});
      if(!r.ok) throw new Error('could not remove it');
      flash('Removed');
      setTimeout(()=>location.reload(), 800);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }

  if(b.dataset.act === 'resort'){
    b.disabled = true; b.textContent = 'Sorting…';
    try {
      const r = await post('/api/categories/classify');
      flash('Sorted ' + (r.by_keyword + r.by_model) + ' of ' + r.pending +
            ' (' + r.by_keyword + ' by keyword, ' + r.calls + ' model call' +
            (r.calls === 1 ? '' : 's') + ')');
    } catch(e){ flash(e.message); }
    b.disabled = false; b.textContent = 'Re-sort every skip now';
    return;
  }
  if(b.dataset.act === 'close-settings'){ settingsEl.close(); return; }
  if(b.dataset.panel){ showPanel(b.dataset.panel); return; }

  if(b.dataset.act === 'make-default'){
    b.disabled = true;
    try {
      await post('/api/profiles/' + b.dataset.pid + '/default');
      flash('Default profile changed');
      setTimeout(()=>location.reload(), 900);
    } catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'refresh-signature'){
    b.disabled = true;
    try {
      const r = await fetch('/api/zoho/signature?refresh=1', {credentials:'same-origin'});
      const d = await r.json();
      flash(d.ok === false ? (d.error || 'Could not read the signature') : 'Signature refreshed');
    } catch(e){ flash(e.message); }
    b.disabled = false;
    return;
  }
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
