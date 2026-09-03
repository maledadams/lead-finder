// The dashboard. Served straight from the Worker so it reads live D1 data.
//
// This is the answer to "I want to see my lead data" — GA4 measures traffic on
// a site you own and cannot show you a lead database.

import { NICHES } from './config.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function renderDashboard(db, env, day, nonce = '') {
  const [queue, funnel, budget, runs, frontier] = await Promise.all([
    db.prepare(
      `SELECT o.id AS oid, o.rank, o.subject, o.body, o.status, o.persona,
              e.id AS eid, e.display_name, e.website, e.domain, e.instagram,
              e.contact_email, e.score, e.score_reason, e.niche,
              e.website_opportunity, e.system_opportunity, e.power_signals, e.personalization
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.queue_date = ? ORDER BY o.rank ASC`
    ).bind(day).all(),
    db.prepare('SELECT state, COUNT(*) AS n FROM entities GROUP BY state ORDER BY n DESC').all(),
    db.prepare('SELECT metric, used FROM budget WHERE day = ?').bind(day).all(),
    db.prepare('SELECT kind, started_at, finished_at, stats, error FROM runs ORDER BY started_at DESC LIMIT 6').all(),
    db.prepare("SELECT status, COUNT(*) AS n FROM crawl_frontier GROUP BY status").all(),
  ]);

  const rows = queue.results || [];
  const states = funnel.results || [];
  const totalEntities = states.reduce((a, r) => a + r.n, 0);
  const budgetMap = Object.fromEntries((budget.results || []).map((r) => [r.metric, r.used]));
  const frontierMap = Object.fromEntries((frontier.results || []).map((r) => [r.status, r.n]));

  const limits = {
    fetch: Number(env.DAILY_FETCH_BUDGET || 300),
    ai: Number(env.DAILY_AI_BUDGET || 40),
  };

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lead finder — ${esc(day)}</title>
<style>
  :root{
    --bg:#faf8f6; --panel:#fff; --ink:#1b1a19; --muted:#6b6560; --line:#e6e0da;
    --accent:#b4472f; --good:#2f7d5c; --warn:#a8741a; --chip:#f2ece6;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#141312; --panel:#1c1b1a; --ink:#f0ece8; --muted:#9a938c; --line:#302d2a;
    --accent:#e2795c; --good:#63b491; --warn:#d3a154; --chip:#262321;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,system-ui,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:22px;margin:0 0 2px;letter-spacing:-.02em}
  .sub{color:var(--muted);font-size:13px;margin-bottom:22px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:24px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .stat b{display:block;font-size:24px;letter-spacing:-.02em}
  .stat span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .bar{height:4px;background:var(--chip);border-radius:2px;margin-top:8px;overflow:hidden}
  .bar i{display:block;height:100%;background:var(--good)}
  .bar i.hot{background:var(--warn)}
  .bar i.max{background:var(--accent)}
  .lead{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:16px 18px;margin-bottom:12px}
  .lead header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
  .rank{color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px;min-width:22px}
  .name{font-weight:640;font-size:16px;letter-spacing:-.01em}
  .score{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:640;color:var(--accent)}
  .chips{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}
  .chip{background:var(--chip);border-radius:99px;padding:2px 9px;font-size:11px;color:var(--muted)}
  .opp{font-size:13.5px;margin:6px 0;color:var(--ink)}
  .opp b{font-weight:620}
  a{color:var(--accent)}
  details{margin-top:10px}
  summary{cursor:pointer;font-size:13px;color:var(--muted);user-select:none}
  pre{background:var(--chip);border-radius:8px;padding:12px;white-space:pre-wrap;
    font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0 0;overflow-x:auto}
  .acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
  button{font:inherit;font-size:13px;padding:5px 12px;border-radius:7px;
    border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
  button:hover{border-color:var(--accent)}
  button.p{background:var(--accent);border-color:var(--accent);color:#fff}
  .empty{background:var(--panel);border:1px dashed var(--line);border-radius:12px;
    padding:32px;text-align:center;color:var(--muted)}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
    margin:30px 0 10px;font-weight:620}
  table{width:100%;border-collapse:collapse;font-size:13px;background:var(--panel);
    border:1px solid var(--line);border-radius:10px;overflow:hidden}
  td,th{padding:7px 12px;text-align:left;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:590;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:none}
  .seed{display:flex;gap:8px;margin-top:8px}
  textarea{flex:1;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px;border-radius:8px;
    border:1px solid var(--line);background:var(--panel);color:var(--ink);min-height:74px;resize:vertical}
  .note{font-size:12.5px;color:var(--muted);margin-top:6px}
</style></head><body><div class="wrap">

<h1>lead finder</h1>
<div class="sub">${esc(day)} · ${rows.length} of max ${esc(env.DAILY_QUEUE_MAX || 30)} today · ${totalEntities} businesses known</div>

<div class="grid">
  ${stat('in queue today', rows.length, null)}
  ${stat('known businesses', totalEntities, null)}
  ${stat('frontier pending', frontierMap.PENDING || 0, null)}
  ${meter('fetch budget', budgetMap.fetch || 0, limits.fetch)}
  ${meter('ai calls', budgetMap.ai || 0, limits.ai)}
</div>

<h2>today's queue</h2>
${rows.length ? rows.map(leadCard).join('') : `<div class="empty">
  <b>Nothing cleared the bar today.</b><br>
  That is the system working correctly, not a failure.<br>
  Add seeds below, or lower <code>MIN_SCORE_TO_QUEUE</code> if you think the bar is wrong.
</div>`}

<h2>add seeds</h2>
<div class="note">One per line. A domain, a full URL, an Instagram or Etsy link, or an @handle.
Everything downstream is automatic — the crawler expands outward from whatever you paste.</div>
<div class="seed">
  <textarea id="seeds" placeholder="cutebrand.com&#10;https://instagram.com/somestudio&#10;@anotherbrand&#10;https://etsy.com/shop/thatceramicsshop"></textarea>
</div>
<div class="acts"><button class="p" data-do="seed">add to pipeline</button>
<button data-do="crawl">run crawl now</button>
<button data-do="queue">rebuild queue</button></div>
<div class="note" id="seedmsg"></div>

<h2>pipeline</h2>
<table><tr><th>state</th><th>count</th></tr>
${states.map((s) => `<tr><td>${esc(s.state)}</td><td>${s.n}</td></tr>`).join('')}
</table>

<h2>recent runs</h2>
<table><tr><th>kind</th><th>started</th><th>result</th></tr>
${(runs.results || []).map((r) => `<tr>
  <td>${esc(r.kind)}</td>
  <td>${esc((r.started_at || '').replace('T', ' ').slice(0, 16))}</td>
  <td>${r.error ? `<span style="color:var(--accent)">${esc(r.error.slice(0, 90))}</span>`
       : esc(summarize(r.stats))}</td></tr>`).join('')}
</table>

<script nonce="${esc(nonce)}">
const key = new URLSearchParams(location.search).get('key') || '';
// The key travels in an Authorization header, never in the URLs this page
// builds, so it does not end up in logs or history for every action.
async function post(path, body){
  const r = await fetch(path, {
    method:'POST',
    headers: Object.assign({'content-type':'application/json'},
      key ? {authorization: 'Bearer ' + key} : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}
const msg = (t) => { document.getElementById('seedmsg').textContent = t; };

async function addSeeds(){
  const raw = document.getElementById('seeds').value.trim();
  if(!raw) return;
  msg('adding…');
  const res = await post('/api/seed', {seeds: raw.split('\n').map(s=>s.trim()).filter(Boolean)});
  msg('added ' + res.accepted + ' new, ' + res.duplicates + ' already known' +
      (res.rejected && res.rejected.length ? ', ' + res.rejected.length + ' unparseable' : ''));
  document.getElementById('seeds').value = '';
}
async function run(kind){
  msg('running ' + kind + '… a crawl can take a few minutes');
  try {
    const res = await post('/api/run/' + kind);
    msg(JSON.stringify(res).slice(0, 300));
  } catch (e) { msg('failed: ' + e.message); }
  if(kind === 'queue') setTimeout(()=>location.reload(), 900);
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('button');
  if(!el) return;

  if(el.dataset.do === 'seed') return addSeeds();
  if(el.dataset.do === 'crawl') return run('crawl');
  if(el.dataset.do === 'queue') return run('queue');

  if(el.dataset.copy){
    const pre = document.getElementById('b' + el.dataset.copy);
    await navigator.clipboard.writeText(pre.textContent);
    el.textContent = 'copied ✓';
    return;
  }
  if(el.dataset.act){
    el.disabled = true;
    await post('/api/outreach/' + el.dataset.id + '/' + el.dataset.act);
    location.reload();
  }
});
</script>
</div></body></html>`;

  function stat(label, value) {
    return `<div class="stat"><span>${esc(label)}</span><b>${value}</b></div>`;
  }
  function meter(label, used, limit) {
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const cls = pct >= 90 ? 'max' : pct >= 60 ? 'hot' : '';
    return `<div class="stat"><span>${esc(label)}</span><b>${used}<span style="font-size:13px;color:var(--muted)"> / ${limit}</span></b>
      <div class="bar"><i class="${cls}" style="width:${pct}%"></i></div></div>`;
  }
}

function leadCard(r) {
  const p = safe(r.personalization) || {};
  const power = safe(r.power_signals) || [];
  const niche = NICHES[r.niche]?.label || r.niche || '—';

  return `<div class="lead">
    <header>
      <span class="rank">${r.rank}</span>
      <span class="name">${esc(r.display_name || r.domain || 'unnamed')}</span>
      ${r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener noreferrer">site ↗</a>` : ''}
      ${r.instagram ? `<a href="https://instagram.com/${esc(r.instagram)}" target="_blank" rel="noopener noreferrer">ig ↗</a>` : ''}
      <span class="score">${r.score}</span>
    </header>
    <div class="chips">
      <span class="chip">${esc(niche)}</span>
      ${r.contact_email ? `<span class="chip">${esc(r.contact_email)}</span>` : '<span class="chip">no email</span>'}
      ${power.slice(0, 4).map((s) => `<span class="chip">${esc(String(s).replace(/_/g, ' '))}</span>`).join('')}
    </div>
    ${p.liked ? `<div class="opp"><b>liked:</b> ${esc(p.liked)}</div>` : ''}
    ${r.website_opportunity ? `<div class="opp"><b>website:</b> ${esc(r.website_opportunity)}</div>` : ''}
    ${r.system_opportunity ? `<div class="opp"><b>system:</b> ${esc(r.system_opportunity)}</div>` : ''}
    <details><summary>draft — ${esc(r.subject)}</summary>
      <pre id="b${esc(r.oid)}">${esc(r.body)}</pre></details>
    <div class="acts">
      <button data-copy="${esc(r.oid)}">copy draft</button>
      <button class="p" data-act="sent" data-id="${esc(r.oid)}">mark sent</button>
      <button data-act="skip" data-id="${esc(r.oid)}">skip</button>
      <button data-act="suppress" data-id="${esc(r.oid)}">never contact</button>
      <span style="align-self:center;color:var(--muted);font-size:12px">${esc(r.status)}</span>
    </div>
  </div>`;
}

function safe(s) { try { return JSON.parse(s); } catch { return null; } }

function summarize(statsJson) {
  const s = safe(statsJson);
  if (!s) return '—';
  if (s.queued !== undefined) return `queued ${s.queued} of ${s.considered} considered`;
  return `fetched ${s.fetched}, ai ${s.evaluated_ai}, new ${s.new_entities}, qualified ${s.qualified}`;
}
