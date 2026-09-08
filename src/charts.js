// Charts, drawn as inline SVG.
//
// No charting library on purpose. The page ships under a CSP of
// `default-src 'none'` with no CDN, so anything loaded from elsewhere is
// blocked outright — and a whole library would cost more than the entire page
// currently weighs to draw six small figures.
//
// Colour is not chosen here. Every mark takes a CSS variable set by the
// stylesheet (--c1..--c5), so light and dark each get their own validated
// steps rather than one palette flipped between them.
//
// Hover is native: every mark carries a <title>, which browsers render as a
// tooltip with no script and no listener. That also makes the value reachable
// to a screen reader, which a div-based tooltip would not be.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nice = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v * 10) / 10);
};

export const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
export const pctLabel = (part, whole) => (whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : '—');

/** Nothing to draw yet. Said plainly rather than as an empty axis. */
export function noData(msg = 'Nothing in this period yet.') {
  return `<div class="nodata">${esc(msg)}</div>`;
}

/**
 * Donut. For identity — which slice of the whole each outcome is.
 *
 * Rendered as stroked arcs on one circle rather than paths: the maths is a
 * dash offset, and a 2px surface-coloured gap falls out of the dash array,
 * which is the spacer the marks spec asks for between adjacent fills.
 */
export function donut(segments, { size = 168, thickness = 22, centre = '' } = {}) {
  const rows = (segments || []).filter((s) => Number(s.value) > 0);
  const total = rows.reduce((a, s) => a + Number(s.value), 0);
  if (!total) return noData();

  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const gap = rows.length > 1 ? 2 : 0;

  let offset = 0;
  const arcs = rows.map((s) => {
    const frac = Number(s.value) / total;
    const len = Math.max(circ * frac - gap, 0.5);
    const seg = `<circle class="arc" r="${r}" cx="${size / 2}" cy="${size / 2}"
      fill="none" stroke="var(--c${s.slot})" stroke-width="${thickness}"
      stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" stroke-linecap="butt"
      transform="rotate(-90 ${size / 2} ${size / 2})"
      ><title>${esc(s.label)}: ${nice(s.value)} (${(frac * 100).toFixed(1)}%)</title></circle>`;
    offset += circ * frac;
    return seg;
  }).join('');

  return `<div class="fig">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
         aria-label="${esc(rows.map((s) => `${s.label} ${s.value}`).join(', '))}">
      ${arcs}
      ${centre ? `<text x="${size / 2}" y="${size / 2 - 2}" class="ctr">${esc(centre)}</text>
      <text x="${size / 2}" y="${size / 2 + 16}" class="ctrsub">of sends</text>` : ''}
    </svg>
    ${legend(rows, total)}
  </div>`;
}

/** Identity is never colour alone: every series is named, with its value. */
function legend(rows, total) {
  return `<ul class="legend">${rows.map((s) => `<li>
    <span class="sw" style="background:var(--c${s.slot})"></span>
    <span class="lb">${esc(s.label)}</span>
    <span class="vl">${nice(s.value)}<span class="dimmed"> · ${(s.value / total * 100).toFixed(0)}%</span></span>
  </li>`).join('')}</ul>`;
}

/**
 * Horizontal bars. For magnitude across named things — the form that survives
 * long labels, which vertical bars do not.
 *
 * `slot` colours by identity; omit it and every bar takes the one accent,
 * which is right when the label already carries the identity.
 */
export function barsH(rows, { max = null, unit = '', slot = 1 } = {}) {
  const data = (rows || []).filter((r) => r && r.label != null);
  if (!data.length) return noData();
  const top = max ?? Math.max(...data.map((r) => Number(r.value) || 0), 1);

  return `<div class="bars">${data.map((r) => {
    const v = Number(r.value) || 0;
    const w = Math.max(pct(v, top), v > 0 ? 1.5 : 0);
    return `<div class="bar" title="${esc(r.label)}: ${esc(r.display ?? nice(v))}${esc(unit)}">
      <span class="bl">${esc(r.label)}</span>
      <span class="btrack"><span class="bfill" style="width:${w.toFixed(1)}%;background:var(--c${r.slot ?? slot})"></span></span>
      <span class="bv">${esc(r.display ?? nice(v))}${esc(unit)}</span>
    </div>`;
  }).join('')}</div>`;
}

/**
 * Grouped columns over time.
 *
 * One shared y-scale for every series — never a second axis. Two measures of
 * different magnitude belong in two figures, not on two scales in one.
 */
export function columns(buckets, series, { height = 150 } = {}) {
  const b = buckets || [];
  if (!b.length) return noData();
  const top = Math.max(
    ...series.flatMap((s) => b.map((x) => Number(x[s.key]) || 0)), 1
  );
  const per = 100 / b.length;
  const w = Math.min(per / series.length * 0.62, 9);

  return `<div class="fig">
    <div class="cols" style="height:${height}px">
      ${b.map((row, i) => series.map((s, j) => {
    const v = Number(row[s.key]) || 0;
    const h = v > 0 ? Math.max(pct(v, top), 1.5) : 0;
    const left = per * i + per * 0.5 + (j - (series.length - 1) / 2) * (w + 1.2);
    return `<span class="col" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%;
      height:${h.toFixed(1)}%;background:var(--c${s.slot})"
      title="${esc(row.label)} · ${esc(s.label)}: ${nice(v)}"></span>`;
  }).join('')).join('')}
      <span class="gl" style="bottom:100%"></span>
      <span class="gl" style="bottom:50%"></span>
    </div>
    <div class="xax">${b.map((row) => `<span>${esc(row.short ?? row.label)}</span>`).join('')}</div>
    <ul class="legend row">${series.map((s) => `<li>
      <span class="sw" style="background:var(--c${s.slot})"></span>
      <span class="lb">${esc(s.label)}</span></li>`).join('')}</ul>
    <div class="axmax">peak ${nice(top)}</div>
  </div>`;
}

/**
 * Funnel. Magnitude down one path, so a single hue darkening by depth —
 * sequential, never a different colour per stage, which would imply the
 * stages are unrelated categories.
 */
export function funnel(stages) {
  const rows = (stages || []).filter(Boolean);
  if (!rows.length || !Number(rows[0].value)) return noData();
  const top = Number(rows[0].value) || 1;

  return `<div class="funnel">${rows.map((s, i) => {
    const v = Number(s.value) || 0;
    const w = Math.max(pct(v, top), v > 0 ? 2 : 0);
    const prev = i > 0 ? Number(rows[i - 1].value) || 0 : null;
    const drop = prev !== null && prev > 0 ? `, ${(v / prev * 100).toFixed(0)}% of the step before` : '';
    return `<div class="fstep" title="${esc(s.label)}: ${nice(v)}${esc(drop)}">
      <span class="fl">${esc(s.label)}</span>
      <span class="ftrack"><span class="ffill" style="width:${w.toFixed(1)}%;opacity:${(1 - i * 0.13).toFixed(2)}"></span></span>
      <span class="fv">${nice(v)}${prev !== null && prev > 0
      ? `<span class="dimmed"> ${(v / prev * 100).toFixed(0)}%</span>` : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

/** A hero number, when the answer is one number and a chart would dilute it. */
export function stat(label, value, { sub = '', tone = '' } = {}) {
  return `<div class="stat">
    <div class="sl">${esc(label)}</div>
    <div class="sv ${esc(tone)}">${esc(value)}</div>
    ${sub ? `<div class="ss">${esc(sub)}</div>` : ''}
  </div>`;
}

/**
 * The table behind a figure.
 *
 * Required, not optional: it is how the numbers reach a screen reader, and it
 * is the relief the palette validator demands where a dark-mode step lands
 * under 3:1 against its surface.
 */
export function table(caption, headers, rows) {
  if (!rows?.length) return '';
  return `<details class="tbl"><summary>${esc(caption)} as a table</summary>
    <table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></details>`;
}
