// What the numbers say.
//
// Chosen to answer questions that change what Lucía does next, not to fill a
// page: is the outreach landing, is the list clean, does the score actually
// predict a reply, and which niches are worth the crawl budget. A metric that
// cannot change a decision is not here.

import { barsH, columns, donut, funnel, noData, pctLabel, stat, table } from './charts.js';
import { categoryCounts } from './categories.js';

export const PERIODS = { day: 'Today', month: 'This month', year: 'This year', all: 'All time' };

/**
 * The window, as SQL date bounds.
 *
 * Everything is stored as ISO strings, so a string comparison IS a date
 * comparison and no parsing is needed on either side.
 */
export function bounds(period, now = new Date(), day = null) {
  const iso = now.toISOString();
  const today = iso.slice(0, 10);
  // Open-ended at the top: '9999' sorts above every ISO date, so the same
  // half-open comparison works for every period and no query needs a special
  // case. Without an upper bound "a specific day" is not expressible at all.
  const END = '9999-12-31';

  if (period === 'day') {
    // Any day, not only today. A named day is a closed window; today is left
    // open so a send five minutes from now still lands inside it.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : today;
    return {
      from: d,
      to: d === today ? END : nextDay(d),
      label: d === today ? 'today' : `on ${d}`,
      bucket: 'hour',
      day: d,
    };
  }
  if (period === 'month') return { from: `${iso.slice(0, 7)}-01`, to: END, label: 'this month', bucket: 'day' };
  if (period === 'year') return { from: `${iso.slice(0, 4)}-01-01`, to: END, label: 'this year', bucket: 'month' };
  return { from: '0000-01-01', to: END, label: 'all time', bucket: 'month' };
}

/** The day after, so a single day can be asked for as a half-open window. */
const nextDay = (d) =>
  new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10);

export async function renderMetrics(db, env, { period = 'month', profile, day = null } = {}) {
  // Nothing on this page may mix profiles: the whole point of switching is that
  // the numbers change. A missing profile fails rather than silently totalling
  // both operations together.
  if (!profile?.id) throw new Error('renderMetrics needs a profile');
  const pid = profile.id;
  const { from, to, label, bucket, day: onDay } = bounds(period, new Date(), day);

  // Bucketing happens in SQLite rather than in JS: it keeps the rows returned
  // proportional to the number of buckets instead of the number of sends.
  const bucketExpr = bucket === 'hour' ? "substr(o.sent_at, 12, 2) || ':00'"
    : bucket === 'day' ? 'substr(o.sent_at, 1, 10)'
      : 'substr(o.sent_at, 1, 7)';

  const [outcome, volume, pipeline, byNiche, byScore, spend, skips, places] = await Promise.all([
    // Every sent email, by what came of it.
    db.prepare(
      `SELECT
         SUM(CASE WHEN e.response_status = 'REPLIED'  THEN 1 ELSE 0 END) AS replied,
         SUM(CASE WHEN e.response_status = 'NO_REPLY' THEN 1 ELSE 0 END) AS no_reply,
         SUM(CASE WHEN e.response_status = 'GHOSTED'  THEN 1 ELSE 0 END) AS ghosted,
         SUM(CASE WHEN e.response_status IS NULL      THEN 1 ELSE 0 END) AS awaiting,
         COUNT(*) AS sent
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.profile_id = ? AND o.status = 'SENT' AND substr(o.sent_at,1,10) >= ? AND substr(o.sent_at,1,10) < ?`
    ).bind(pid, from, to).first(),

    db.prepare(
      `SELECT ${bucketExpr} AS label,
              SUM(CASE WHEN o.status = 'SENT' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN o.status = 'BOUNCED' THEN 1 ELSE 0 END) AS bounced
       FROM outreach o
       WHERE o.profile_id = ? AND o.sent_at IS NOT NULL
         AND substr(o.sent_at,1,10) >= ? AND substr(o.sent_at,1,10) < ?
       GROUP BY label ORDER BY label`
    ).bind(pid, from, to).all(),

    // The whole funnel, all time — a funnel scoped to a day is meaningless
    // because the stages are reached weeks apart.
    db.prepare(
      `SELECT
         COUNT(*) AS discovered,
         SUM(CASE WHEN state NOT IN ('DISCOVERED') THEN 1 ELSE 0 END) AS evaluated,
         SUM(CASE WHEN state IN ('QUALIFIED','SHORTLISTED','OUTREACH_READY','CONTACTED','REPLIED','CONVERSATION','CLIENT') THEN 1 ELSE 0 END) AS qualified,
         SUM(CASE WHEN state IN ('CONTACTED','REPLIED','CONVERSATION','CLIENT') THEN 1 ELSE 0 END) AS contacted,
         SUM(CASE WHEN state IN ('REPLIED','CONVERSATION','CLIENT') THEN 1 ELSE 0 END) AS replied,
         SUM(CASE WHEN state = 'CLIENT' THEN 1 ELSE 0 END) AS client
       FROM entities WHERE profile_id = ?`
    ).bind(pid).first(),

    db.prepare(
      `SELECT e.niche AS niche, COUNT(*) AS sent,
              SUM(CASE WHEN e.response_status = 'REPLIED' THEN 1 ELSE 0 END) AS replied
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.profile_id = ? AND o.status = 'SENT'
         AND substr(o.sent_at,1,10) >= ? AND substr(o.sent_at,1,10) < ?
       GROUP BY e.niche HAVING sent > 0 ORDER BY sent DESC LIMIT 8`
    ).bind(pid, from, to).all(),

    // Does the score predict a reply? If it does not, the scoring is decoration.
    db.prepare(
      `SELECT CASE
                WHEN e.score >= 85 THEN '85+'
                WHEN e.score >= 75 THEN '75-84'
                WHEN e.score >= 68 THEN '68-74'
                WHEN e.score >= 50 THEN '50-67'
                ELSE 'under 50' END AS band,
              COUNT(*) AS sent,
              SUM(CASE WHEN e.response_status = 'REPLIED' THEN 1 ELSE 0 END) AS replied
       FROM outreach o JOIN entities e ON e.id = o.entity_id
       WHERE o.profile_id = ? AND o.status = 'SENT' AND e.score IS NOT NULL
         AND substr(o.sent_at,1,10) >= ? AND substr(o.sent_at,1,10) < ?
       GROUP BY band`
    ).bind(pid, from, to).all(),

    db.prepare(
      `SELECT metric, SUM(used) AS used FROM budget
       WHERE profile_id = ? AND day >= ? AND day < ? GROUP BY metric ORDER BY used DESC`
    ).bind(pid, from, to).all(),

    // Your categories, not the raw sentences. See src/categories.js.
    categoryCounts(db, pid, from, to),

    // Where the leads actually came from. location_text is "City, ST" for 1,934
    // of the 1,958 rows; the metro key is the fallback for the older ones that
    // predate the state suffix.
    db.prepare(
      `SELECT
         CASE
           WHEN location_text LIKE '%, __' THEN substr(location_text, -2)
           WHEN discovery_source LIKE 'osm:%' AND substr(discovery_source, -3, 1) = '-'
             THEN upper(substr(discovery_source, -2))
           ELSE NULL END AS state,
         COALESCE(NULLIF(location_text, ''), replace(discovery_source, 'osm:', '')) AS place,
         COUNT(*) AS n
       FROM entities
       WHERE profile_id = ? AND first_seen_at >= ? AND first_seen_at < ?
       GROUP BY state, place`
    ).bind(pid, from, to).all(),
  ]);

  // Rolled up here rather than in SQL: one pass over a few hundred rows is
  // cheaper than a second query, and the cities have to be kept anyway for the
  // per-state breakdown underneath each bar.
  const states = new Map();
  for (const row of places.results || []) {
    const key = row.state || 'Unknown';
    if (!states.has(key)) states.set(key, { state: key, n: 0, cities: [] });
    const s = states.get(key);
    s.n += Number(row.n) || 0;
    if (row.place) s.cities.push({ place: row.place, n: Number(row.n) || 0 });
  }
  const byState = [...states.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .map((s) => ({ ...s, cities: s.cities.sort((a, b) => b.n - a.n).slice(0, 12) }));

  const o = outcome || {};
  const sent = Number(o.sent) || 0;
  const replied = Number(o.replied) || 0;

  const vol = volume.results || [];
  const bounced = vol.reduce((a, r) => a + (Number(r.bounced) || 0), 0);
  const spendRows = spend.results || [];
  const aiSpend = spendRows.reduce((a, r) => a + (Number(r.used) || 0), 0);

  const nicheRows = (byNiche.results || []).map((r) => ({
    label: profile.niches?.[r.niche]?.label || r.niche || 'unknown',
    value: pctOf(r.replied, r.sent),
    display: `${pctLabel(r.replied, r.sent)}`,
    sent: r.sent, replied: r.replied,
  }));

  const bandOrder = ['85+', '75-84', '68-74', '50-67', 'under 50'];
  const scoreRows = bandOrder
    .map((b) => (byScore.results || []).find((r) => r.band === b))
    .filter(Boolean)
    .map((r) => ({
      label: r.band,
      value: pctOf(r.replied, r.sent),
      display: pctLabel(r.replied, r.sent),
      sent: r.sent, replied: r.replied,
    }));

  return `
<div class="head">
  <h1>Metrics</h1>
  <span class="dim sm">${escLabel(label)}</span>
  <nav class="seg" aria-label="Period">
    ${Object.entries(PERIODS).map(([k, v]) =>
    `<a class="sgi${k === period ? ' on' : ''}" href="/metrics?period=${k}"${k === period ? ' aria-current="page"' : ''}>${v}</a>`).join('')}
  </nav>
  <label class="lb vh" for="metric-day">Show a particular day</label>
  <input id="metric-day" type="date" value="${escLabel(onDay || '')}" data-filter="day"
         max="${escLabel(new Date().toISOString().slice(0, 10))}"
         title="Show a particular day">
</div>
<p class="cap">Days run midnight to midnight UTC, which is how the timestamps are
  stored — not your local midnight.</p>

<div class="grid stats">
  ${stat('Reply rate', pctLabel(replied, sent), {
    sub: sent ? `${replied} of ${sent} sent` : 'nothing sent yet',
    tone: sent && replied / sent >= 0.1 ? 'good' : '',
  })}
  ${stat('Emails sent', String(sent), { sub: `${Number(o.awaiting) || 0} still waiting` })}
  ${stat('Bounce rate', pctLabel(bounced, sent + bounced), {
    sub: bounced ? `${bounced} dead address${bounced === 1 ? '' : 'es'}` : 'no bounces',
    tone: bounced && bounced / Math.max(sent + bounced, 1) > 0.05 ? 'bad' : '',
  })}
  ${stat('Work per reply', replied ? `${Math.round(aiSpend / replied)}` : '—', {
    sub: replied ? 'AI + fetch units spent per reply' : 'no replies yet',
  })}
</div>

<div class="grid two">
  <section class="card">
    <h3>What came of the sends</h3>
    <p class="cap">Every email sent ${escLabel(label)}, by outcome.</p>
    ${sent ? donut([
    { label: 'Replied', value: o.replied, slot: 4 },
    { label: 'Still waiting', value: o.awaiting, slot: 1 },
    { label: 'Ghosted', value: o.ghosted, slot: 2 },
    { label: 'No reply', value: o.no_reply, slot: 3 },
    { label: 'Bounced', value: bounced, slot: 5 },
  ], { centre: pctLabel(replied, sent) }) : noData('No emails sent in this period.')}
    ${table('Outcomes', ['Outcome', 'Count'], sent ? [
    ['Replied', o.replied], ['Still waiting', o.awaiting], ['Ghosted', o.ghosted],
    ['No reply', o.no_reply], ['Bounced', bounced],
  ] : [])}
  </section>

  <section class="card">
    <h3>Sending over time</h3>
    <p class="cap">Sent against bounced, on one scale.</p>
    ${columns(
    vol.map((r) => ({ ...r, short: shortLabel(r.label, bucket) })),
    [{ key: 'sent', label: 'Sent', slot: 1 }, { key: 'bounced', label: 'Bounced', slot: 5 }]
  )}
    ${table('Sending', ['Period', 'Sent', 'Bounced'], vol.map((r) => [r.label, r.sent, r.bounced]))}
  </section>
</div>

<div class="grid two">
  <section class="card">
    <h3>Where leads stop</h3>
    <p class="cap">All time, because the stages are weeks apart. Each step shows
      what fraction of the one above it survived.</p>
    ${funnel([
    { label: 'Discovered', value: pipeline?.discovered },
    { label: 'Evaluated', value: pipeline?.evaluated },
    { label: 'Good enough to write to', value: pipeline?.qualified },
    { label: 'Contacted', value: pipeline?.contacted },
    { label: 'Replied', value: pipeline?.replied },
    { label: 'Became a client', value: pipeline?.client },
  ])}
  </section>

  <section class="card">
    <h3>Does the score predict a reply?</h3>
    <p class="cap">Reply rate by the score the lead had when it was written to.
      If the bars do not descend, the score is not earning its keep.</p>
    ${scoreRows.length ? barsH(scoreRows, { max: 100, slot: 1 })
    : noData('Not enough sends with a score yet.')}
    ${table('Score bands', ['Score', 'Sent', 'Replied', 'Reply rate'],
    scoreRows.map((r) => [r.label, r.sent, r.replied, r.display]))}
  </section>
</div>

<div class="grid two">
  <section class="card">
    <h3>Reply rate by niche</h3>
    <p class="cap">Where the answers actually come from ${escLabel(label)}.</p>
    ${nicheRows.length ? barsH(nicheRows, { max: 100, slot: 3 })
    : noData('No sends to compare yet.')}
    ${table('Niches', ['Niche', 'Sent', 'Replied', 'Reply rate'],
    nicheRows.map((r) => [r.label, r.sent, r.replied, r.display]))}
  </section>

  <section class="card">
    <h3>What the crawl spent</h3>
    <p class="cap">Units drawn against the daily ceilings, ${escLabel(label)}.</p>
    ${spendRows.length ? barsH(
    spendRows.map((r, i) => ({ label: SPEND_LABEL[r.metric] || r.metric, value: r.used, slot: (i % 5) + 1 })),
  ) : noData('No spend recorded in this period.')}
    ${table('Spend', ['Resource', 'Units'], spendRows.map((r) => [SPEND_LABEL[r.metric] || r.metric, r.used]))}
  </section>
</div>

<div class="grid two">
  <section class="card">
    <h3>Why you skipped things</h3>
    <p class="cap">Your categories, busiest first ${escLabel(label)}. Edit them in
      Settings — the bars follow whatever you define there.</p>
    ${(skips || []).length
      ? barsH(skips.map((r) => ({ label: trimTo(r.label, 40), value: r.n })), { slot: 2 })
      : noData('Nothing skipped in this period.')}
  </section>

  <section class="card">
    <h3>Where the leads come from</h3>
    <p class="cap">States found ${escLabel(label)}, busiest first. Open one for its cities.</p>
    ${byState.length
      ? `${barsH(byState.map((r) => ({ label: r.state, value: r.n })), { slot: 3 })}
         ${byState.map((r) => `<details class="tbl">
           <summary>${escLabel(r.state)} — ${r.n} lead${r.n === 1 ? '' : 's'}</summary>
           ${table(['City', 'Leads'], r.cities.map((c) => [trimTo(c.place, 42), c.n]))}
         </details>`).join('')}`
      : noData('No leads discovered in this period.')}
  </section>
</div>
`;
}

const SPEND_LABEL = {
  ai: 'AI evaluations', fetch: 'Page fetches',
  source: 'Source queries', browser: 'Browser renders',
};

const pctOf = (a, b) => (Number(b) > 0 ? (Number(a) / Number(b)) * 100 : 0);
const trimTo = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const escLabel = (s) => String(s ?? '');

function shortLabel(v, bucket) {
  const s = String(v ?? '');
  if (bucket === 'day') return s.slice(8);            // 07
  if (bucket === 'month') return s.slice(5);          // 09
  return s;                                           // 14:00
}
