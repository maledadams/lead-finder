// The pieces more than one page needs: the icon set, the confirm dialog, and
// the settings shell.
//
// Extracted so that settings, the documentation tree and the dashboard share
// one implementation of each rather than three that drift. The confirm dialog
// in particular has to be identical everywhere — a delete that looks different
// on one page is a delete a person clicks without reading.
//
// Everything here is a native element. <dialog> brings a focus trap, Esc to
// close and a real backdrop with no script; <details> brings keyboard and
// screen-reader support for a tree with no ARIA. That is not only the
// accessible choice, it is by some distance the least code.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Icons, drawn in the Phosphor manner — 24px box, one stroke weight, round caps.
 *
 * Inlined rather than pulled from a package, which is not a compromise here:
 * the CSP is `default-src 'none'` with no host allowed, so an icon font or
 * sprite sheet cannot load at all.
 */
export const ICONS = {
  today: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8.2 12.4l2.9 2.9 4.7-5.9"/>',
  sent: '<path d="M20.6 3.4 3.4 9.9l7.1 3.6 3.6 7.1z"/><path d="M10.5 13.5 20.6 3.4"/>',
  skipped: '<circle cx="12" cy="12" r="8.5"/><path d="M6.4 17.6 17.6 6.4"/>',
  bounced: '<path d="M8.2 3.6 3.4 8.4l4.8 4.8"/><path d="M3.4 8.4h11.2a5.9 5.9 0 0 1 5.9 5.9v6.1"/>',
  metrics: '<path d="M4 20h16"/><path d="M7.6 20v-7.4"/><path d="M12 20V6.6"/><path d="M16.4 20v-4.6"/>',
  calendar: '<rect x="3.5" y="5.8" width="17" height="14.7" rx="3.2"/><path d="M8.2 3v4M15.8 3v4M3.5 10.6h17"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/>'
    + '<path d="M12 3.4c2.25 2.4 3.5 5.4 3.5 8.6s-1.25 6.2-3.5 8.6c-2.25-2.4-3.5-5.4-3.5-8.6S9.75 5.8 12 3.4z"/>',
  instagram: '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5"/><circle cx="12" cy="12" r="4.1"/>'
    + '<circle cx="16.85" cy="7.15" r="1.05" fill="currentColor" stroke="none"/>',
  glass: '<circle cx="10.8" cy="10.8" r="6.9"/><path d="M15.9 15.9 21 21"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/>'
    + '<path d="M19.1 14.4a1.6 1.6 0 0 0 .32 1.77l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V20a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1.04-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H4a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.47-1.04 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.06.06a1.6 1.6 0 0 0 1.77.32h.07A1.6 1.6 0 0 0 10.8 4.1V4a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.06a1.6 1.6 0 0 0-.32 1.77v.07a1.6 1.6 0 0 0 1.47.97H20a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.47.97z"/>',
  trash: '<path d="M3.8 6.2h16.4"/><path d="M8.6 6.2V4.6a1.6 1.6 0 0 1 1.6-1.6h3.6a1.6 1.6 0 0 1 1.6 1.6v1.6"/>'
    + '<path d="M18 6.2v13.2a1.6 1.6 0 0 1-1.6 1.6H7.6A1.6 1.6 0 0 1 6 19.4V6.2"/><path d="M10.2 10.6v6M13.8 10.6v6"/>',
  pencil: '<path d="M13.6 4.9 19.1 10.4"/><path d="M15.9 2.6a2.4 2.4 0 0 1 3.5 3.5L7.6 17.9 3 19.5l1.6-4.6z"/>',
  folder: '<path d="M3.6 7.4a2 2 0 0 1 2-2h3.1l2.2 2.6h7.5a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z"/>',
  doc: '<path d="M14 3.2H7.4a2 2 0 0 0-2 2v13.6a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2V7.8z"/>'
    + '<path d="M14 3.2v4.6h4.6"/><path d="M8.8 12.6h6.4M8.8 16.2h4.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export const icon = (name, cls = 'ico') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"`
  + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/**
 * The one confirm dialog, rendered once per page.
 *
 * Every destructive action in the app opens this. Its wording is filled in by
 * the caller, and `requireText` turns it into the typed-name confirmation that
 * guards the things that cannot be undone.
 *
 * The safe answer holds focus when it opens. A dialog that opens with "Delete
 * this" focused is a dialog that deletes on a stray Enter.
 */
export function confirmDialog() {
  return `
<dialog id="confirm" class="sheet ask" aria-labelledby="confirm-title">
  <h2 id="confirm-title">Are you sure you want to delete this?</h2>
  <p class="body" id="confirm-body"></p>
  <label class="typed" id="confirm-typed" hidden>
    <span class="lb" id="confirm-typed-label"></span>
    <input id="confirm-input" type="text" autocomplete="off" spellcheck="false">
  </label>
  <div class="acts end">
    <button id="confirm-no" autofocus>No</button>
    <button id="confirm-yes" class="danger">Delete this</button>
  </div>
</dialog>`;
}

/**
 * The settings sheet: a left rail of panels, a right pane of content.
 *
 * Everything disruptive lives in here rather than scattered across the pages it
 * affects — creating and deleting profiles, skip categories, where to crawl.
 * Panels are plain sections toggled by their button, so the whole thing is one
 * request with no loading states.
 */
export function settingsDialog(panels) {
  const nav = panels.map((p, i) =>
    `<button class="snav${i === 0 ? ' on' : ''}" data-panel="${esc(p.id)}"
       role="tab" aria-selected="${i === 0}" aria-controls="panel-${esc(p.id)}"
     >${icon(p.icon)}<span>${esc(p.label)}</span></button>`).join('');

  const panes = panels.map((p, i) =>
    `<section class="spane" id="panel-${esc(p.id)}" role="tabpanel" ${i === 0 ? '' : 'hidden'}>
       <h2>${esc(p.label)}</h2>
       ${p.hint ? `<p class="cap">${esc(p.hint)}</p>` : ''}
       ${p.body}
     </section>`).join('');

  return `
<dialog id="settings" class="sheet wide" aria-labelledby="settings-title">
  <div class="shead">
    <h1 id="settings-title">Settings</h1>
    <button class="x" data-act="close-settings" aria-label="Close settings">&times;</button>
  </div>
  <div class="sbody">
    <nav class="snavs" role="tablist" aria-label="Settings sections">${nav}</nav>
    <div class="spanes">${panes}</div>
  </div>
</dialog>`;
}
