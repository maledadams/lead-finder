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

import { NICHES } from './config.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function renderDashboard(db, env, day, nonce = '', signedInAs = null) {
  const [queue, counts, lessons, recent] = await Promise.all([
    db.prepare(
      `SELECT o.id AS oid, o.rank, o.subject, o.body, o.status, o.persona,
              e.id AS eid, e.display_name, e.website, e.domain, e.instagram,
              e.phone, e.contact_email, e.score, e.niche, e.location_text,
              e.website_opportunity, e.system_opportunity, e.power_signals,
              e.personalization, e.has_website
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.queue_date = ? ORDER BY o.rank ASC`
    ).bind(day).all(),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM outreach WHERE queue_date = ? AND status = 'DRAFT')   AS todo,
         (SELECT COUNT(*) FROM outreach WHERE queue_date = ? AND status = 'SENT')    AS sent,
         (SELECT COUNT(*) FROM outreach WHERE queue_date = ? AND status = 'SKIPPED') AS skipped,
         (SELECT COUNT(*) FROM entities WHERE state = 'CONTACTED')                   AS all_time`
    ).bind(day, day, day).first(),
    db.prepare('SELECT lesson, kind, weight FROM lessons WHERE active = 1 ORDER BY weight DESC LIMIT 6').all(),
    db.prepare(
      `SELECT f.decision, f.reason, e.display_name FROM feedback f
       JOIN entities e ON e.id = f.entity_id
       WHERE f.reason IS NOT NULL ORDER BY f.created_at DESC LIMIT 4`
    ).all(),
  ]);

  const rows = queue.results || [];
  const todo = rows.filter((r) => r.status === 'DRAFT');
  const done = rows.filter((r) => r.status !== 'DRAFT');
  const c = counts || {};

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leads — ${esc(day)}</title>
<style>
  :root{--bg:#f7f5f3;--card:#fff;--ink:#1a1918;--dim:#6d6763;--line:#e5dfd9;
        --go:#2f7d5c;--no:#b4472f;--warn:#a8741a;--chip:#f0eae4}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#141312;--card:#1d1b1a;--ink:#f1ede9;--dim:#9b938c;--line:#312e2b;
    --go:#63b491;--no:#e2795c;--warn:#d3a154;--chip:#262321}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:24px 18px 120px}
  h1{font-size:20px;margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--dim);font-size:14px;margin-bottom:20px}
  .prog{display:flex;gap:14px;font-size:14px;margin-bottom:24px;flex-wrap:wrap}
  .prog b{font-variant-numeric:tabular-nums}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;
        padding:18px 20px;margin-bottom:14px}
  .card.done{opacity:.5}
  .top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
  .nm{font-size:18px;font-weight:650;letter-spacing:-.01em}
  .where{color:var(--dim);font-size:13px}
  .tag{margin-left:auto;font-size:12px;padding:3px 10px;border-radius:99px;
       background:var(--chip);color:var(--dim);white-space:nowrap}
  .tag.strong{background:color-mix(in srgb,var(--go) 18%,transparent);color:var(--go)}
  .tag.weak{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn)}
  .links{font-size:14px;margin:6px 0 10px}
  .links a{color:var(--no);margin-right:14px}
  .why{font-size:15px;margin:10px 0;padding-left:12px;border-left:2px solid var(--line)}
  .why b{font-weight:620}
  details{margin:12px 0 0}
  summary{cursor:pointer;font-size:14px;color:var(--dim);user-select:none;padding:6px 0}
  .mail{background:var(--chip);border-radius:10px;padding:14px;white-space:pre-wrap;
        font:14px/1.65 ui-sans-serif,system-ui;margin-top:8px}
  .acts{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}
  button{font:inherit;font-size:14px;padding:9px 16px;border-radius:9px;cursor:pointer;
         border:1px solid var(--line);background:var(--card);color:var(--ink)}
  button:hover{border-color:var(--dim)}
  button.go{background:var(--go);border-color:var(--go);color:#fff;font-weight:600}
  button.no{border-color:var(--no);color:var(--no)}
  button:disabled{opacity:.4;cursor:default}
  .reason{display:none;margin-top:12px}
  .reason.open{display:block}
  .reason textarea{width:100%;font:inherit;font-size:14px;padding:10px;border-radius:9px;
    border:1px solid var(--line);background:var(--bg);color:var(--ink);min-height:64px;resize:vertical}
  .hint{font-size:13px;color:var(--dim);margin:4px 0 8px}
  .empty{background:var(--card);border:1px dashed var(--line);border-radius:14px;
         padding:36px;text-align:center;color:var(--dim)}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
     margin:34px 0 12px;font-weight:650}
  .learned{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px}
  .learned li{font-size:14px;margin:4px 0}
  .learned .k{color:var(--dim);font-size:12px}
  .flash{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
         background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:99px;
         font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9}
  .flash.on{opacity:1}
</style></head><body><div class="wrap">

<h1>Leads to review</h1>
<div class="sub">${esc(day)}${signedInAs
  ? ` &middot; signed in as ${esc(signedInAs)} &middot; <a href="/auth/logout" style="color:var(--dim)">sign out</a>`
  : ''}</div>

<div class="prog">
  <span><b>${todo.length}</b> to review</span>
  <span style="color:var(--go)"><b>${c.sent || 0}</b> sent today</span>
  <span style="color:var(--dim)"><b>${c.skipped || 0}</b> skipped</span>
  <span style="color:var(--dim);margin-left:auto"><b>${c.all_time || 0}</b> contacted all time</span>
</div>

${todo.length ? todo.map(card).join('') : `<div class="empty">
  <b style="color:var(--ink)">Nothing to review right now.</b><br>
  New leads are found overnight and appear here each morning.
</div>`}

${done.length ? `<h2>Already handled today</h2>${done.map(card).join('')}` : ''}

${(lessons.results || []).length ? `<h2>What this has learned from you</h2>
<div class="learned"><ul style="margin:0;padding-left:18px">
${lessons.results.map((l) => `<li>${esc(l.lesson)}
  <span class="k">${l.kind === 'PREFER' ? 'look for this' : 'avoid this'}${l.weight > 1 ? ` &middot; seen ${l.weight}&times;` : ''}</span></li>`).join('')}
</ul></div>` : ''}

${(recent.results || []).length ? `<h2>Recent notes</h2>
<div class="learned">${recent.results.map((r) =>
  `<div style="font-size:14px;margin:6px 0"><b>${esc(r.display_name || '')}</b>
   <span class="k">${esc(String(r.decision).toLowerCase())}</span><br>
   <span style="color:var(--dim)">${esc(r.reason)}</span></div>`).join('')}</div>` : ''}

<div class="flash" id="flash"></div>

<script nonce="${esc(nonce)}">
const key = new URLSearchParams(location.search).get('key') || '';
const flash = (t) => {
  const f = document.getElementById('flash');
  f.textContent = t; f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 2200);
};
async function post(path, body){
  const r = await fetch(path, {
    method:'POST',
    headers: Object.assign({'content-type':'application/json'}, key ? {authorization:'Bearer '+key} : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if(!r.ok) throw new Error('Request failed (' + r.status + ')');
  return r.json();
}
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if(!b) return;
  const card = b.closest('.card');
  const id = card && card.dataset.oid;

  if(b.dataset.copy){
    await navigator.clipboard.writeText(card.querySelector('.mail').textContent.trim());
    b.textContent = 'Copied';
    setTimeout(()=>{ b.textContent = 'Copy email'; }, 1800);
    return;
  }
  if(b.dataset.open === 'reason'){
    card.querySelector('.reason').classList.add('open');
    card.querySelector('.reason textarea').focus();
    return;
  }
  if(b.dataset.act === 'sent'){
    b.disabled = true;
    try { await post('/api/decide/' + id, {decision:'SENT'}); location.reload(); }
    catch(e){ b.disabled = false; flash(e.message); }
    return;
  }
  if(b.dataset.act === 'skip' || b.dataset.act === 'block'){
    const ta = card.querySelector('.reason textarea');
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
</div></body></html>`;
}

function card(r) {
  const p = safe(r.personalization) || {};
  const power = safe(r.power_signals) || [];
  const niche = NICHES[r.niche]?.label || 'Creative business';
  const belowBar = String(r.persona || '').includes('below_bar');
  const noSite = r.has_website === 0;
  const isDone = r.status !== 'DRAFT';

  // Purchasing-power signals, said in English rather than as field names.
  const money = power.slice(0, 3).map((s) => String(s).replace(/_/g, ' ')).join(' · ');

  const tag = belowBar
    ? '<span class="tag weak">worth a look</span>'
    : '<span class="tag strong">strong match</span>';

  return `<div class="card ${isDone ? 'done' : ''}" data-oid="${esc(r.oid)}">
  <div class="top">
    <span class="nm">${esc(r.display_name || r.domain || 'Unnamed business')}</span>
    ${r.location_text ? `<span class="where">${esc(r.location_text)}</span>` : ''}
    ${isDone ? `<span class="tag">${esc(String(r.status).toLowerCase())}</span>` : tag}
  </div>
  <div class="where">${esc(niche)}${money ? ` &middot; ${esc(money)}` : ''}</div>

  <div class="links">
    ${r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener noreferrer">Their website</a>` : ''}
    ${r.instagram ? `<a href="https://instagram.com/${esc(r.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>` : ''}
    ${r.contact_email ? `<span style="color:var(--dim)">${esc(r.contact_email)}</span>` : ''}
  </div>

  ${noSite
    ? '<div class="why"><b>Why:</b> they have no website at all — that is the whole opportunity.</div>'
    : `${r.website_opportunity ? `<div class="why"><b>Website:</b> ${esc(trim(r.website_opportunity))}</div>` : ''}
       ${r.system_opportunity ? `<div class="why"><b>Could also use:</b> ${esc(trim(r.system_opportunity))}</div>` : ''}`}
  ${p.liked ? `<div class="why"><b>Noticed:</b> ${esc(p.liked)}</div>` : ''}

  <details${isDone ? '' : ' open'}>
    <summary>The email — ${esc(r.subject)}</summary>
    <div class="mail">${esc(r.body)}</div>
  </details>

  ${isDone ? '' : `
  <div class="acts">
    <button data-copy="1">Copy email</button>
    <button class="go" data-act="sent">I sent this</button>
    <button class="no" data-open="reason">Skip &hellip;</button>
  </div>
  <div class="reason">
    <div class="hint">Why are you skipping? Be specific — this is what teaches it
      what to stop putting in front of you.</div>
    <textarea placeholder="e.g. their site is already great and there is no obvious system to build"></textarea>
    <div class="acts">
      <button class="no" data-act="skip">Skip this one</button>
      <button data-act="block">Never contact them</button>
    </div>
  </div>`}
</div>`;
}

const trim = (s) => String(s || '').split(' | ')[0].slice(0, 160);
function safe(s) { try { return JSON.parse(s); } catch { return null; } }
