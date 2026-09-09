// The documentation pages.
//
// Kept out of dashboard.js because it is a second application sharing a rail:
// a tree, a reader and an editor, none of which the outreach queue knows about.
//
// THE EDITOR IS THE PAGE. Clicking the pencil turns the document itself into
// fields — the same typography, in the same place — rather than opening a modal
// over it. A dialog would mean writing in one shape and reading in another.
//
// The toolbar only inserts markdown around the selection. The textarea is the
// document, so the whole thing works with the toolbar ignored entirely, which
// is what makes it usable by keyboard.

import { esc, icon, ICONS } from './ui.js';
import { renderMarkdown } from './docs.js';

/** The icons a folder may wear. A fixed set, because uploads mean a file store. */
export const FOLDER_ICONS = [
  'folder', 'doc', 'today', 'sent', 'skipped', 'bounced',
  'metrics', 'calendar', 'globe', 'instagram', 'settings', 'glass',
].filter((n) => ICONS[n]);

const EMPTY = `<div class="empty">
  <b>Nothing written yet.</b><br>
  Documentation is for the reasoning that would otherwise live only in your head —
  how you decide, why a rule exists, what a category is really for.
</div>`;

/** The rail's second pane: the tree, replacing the queue navigation. */
export function docsRail(tree, current) {
  const link = (d) => `<a class="nav sub${current === d.slug ? ' on' : ''}" href="/docs/${
    esc(d.slug)}"${current === d.slug ? ' aria-current="page"' : ''}>${
    icon(d.icon && ICONS[d.icon] ? d.icon : 'doc')}<span>${esc(d.title)}</span></a>`;

  return `
  <a class="nav back" href="/">${icon('bounced')}<span>Back to the queue</span></a>
  <div class="railhead">Documentation</div>
  ${tree.folders.map((f) => `
    <details class="tree" ${f.docs.some((d) => d.slug === current) || f.slug === current ? 'open' : ''}>
      <summary>${icon(f.icon && ICONS[f.icon] ? f.icon : 'folder')}<span>${esc(f.title)}</span>
        <span class="n">${f.docs.length}</span></summary>
      <a class="nav sub folderlink" href="/docs/${esc(f.slug)}">Everything in here</a>
      ${f.docs.map(link).join('')}
    </details>`).join('')}
  ${tree.loose.map(link).join('')}
  <a class="nav new" href="/docs?new=1">${icon('plus')}<span>New page</span></a>`;
}

/** Pencil and trash, on folders and documents alike. */
function tools(doc) {
  return `<div class="tools">
    <a class="tool" href="/docs/${esc(doc.slug)}?edit=1" aria-label="Edit ${esc(doc.title)}"
       title="Edit">${icon('pencil')}</a>
    <button class="tool danger-ico" data-act="del-doc" data-did="${esc(doc.id)}"
            data-title="${esc(doc.title)}" data-folder="${doc.is_folder ? '1' : '0'}"
            aria-label="Delete ${esc(doc.title)}" title="Delete">${icon('trash')}</button>
  </div>`;
}

/** The overview: every folder, and what is in it. */
export function docsIndex(tree) {
  if (!tree.count) return `<div class="head"><h1>Documentation</h1></div>${EMPTY}
    <div class="acts"><a class="btn go" href="/docs?new=1">Write the first page</a></div>`;

  return `
<div class="head">
  <h1>Documentation</h1>
  <span class="dim sm">${tree.count} page${tree.count === 1 ? '' : 's'}</span>
  <a class="btn go pushright" href="/docs?new=1">New page</a>
</div>
${tree.folders.map((f) => `
  <section class="card folder">
    <div class="top">
      ${icon(f.icon && ICONS[f.icon] ? f.icon : 'folder')}
      <h3><a href="/docs/${esc(f.slug)}">${esc(f.title)}</a></h3>
      <span class="dim sm">${f.docs.length} page${f.docs.length === 1 ? '' : 's'}</span>
      ${tools(f)}
    </div>
    ${f.docs.length
      ? `<div class="rows">${f.docs.map((d) => `<div class="row doc">
          <div class="rmain"><a href="/docs/${esc(d.slug)}"><b>${esc(d.title)}</b></a>
            <div class="dim sm">${esc(summarise(d))}</div></div>
        </div>`).join('')}</div>`
      : '<p class="cap">Empty.</p>'}
  </section>`).join('')}
${tree.loose.length ? `<h2>Loose pages</h2><div class="rows">${tree.loose.map((d) => `
  <div class="row doc"><div class="rmain">
    <a href="/docs/${esc(d.slug)}"><b>${esc(d.title)}</b></a>
    <div class="dim sm">${esc(summarise(d))}</div>
  </div></div>`).join('')}</div>` : ''}`;
}

const summarise = (d) => {
  const text = String(d.body_md || '').replace(/[#>*_`\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : (text || 'Empty page');
};

/** A folder, opened: everything inside it, each expandable in place. */
export function folderPage(folder, children) {
  return `
<div class="head">
  <a class="crumb" href="/docs">Documentation</a>
  <h1>${esc(folder.title)}</h1>
  ${tools(folder)}
</div>
${children.length ? children.map((d) => `
  <details class="card doc-expand">
    <summary><b>${esc(d.title)}</b><span class="dim sm">${esc(summarise(d))}</span></summary>
    <article class="prose">${d.body_html || renderMarkdown(d.body_md)}</article>
    <div class="acts"><a class="btn" href="/docs/${esc(d.slug)}">Open the page</a></div>
  </details>`).join('')
  : `<div class="empty"><b>This folder is empty.</b><br>Add a page to it below.</div>`}
<div class="acts"><a class="btn go" href="/docs?new=1&amp;parent=${esc(folder.id)}">New page in here</a></div>`;
}

/** A document, read. */
export function docPage(doc) {
  return `
<div class="head">
  <a class="crumb" href="/docs">Documentation</a>
  <h1>${esc(doc.title)}</h1>
  ${tools(doc)}
</div>
<article class="prose">${doc.body_html || renderMarkdown(doc.body_md)}</article>
<p class="dim sm updated">Last edited ${esc(String(doc.updated_at).slice(0, 10))}</p>`;
}

/**
 * The editor. The page becomes fields; nothing moves.
 *
 * Write and Preview are two panes rather than a live split: the preview is
 * rendered by the server with the same function that renders the saved page, so
 * there is exactly one markdown implementation in the system.
 */
export function docEditor(doc, { folders = [], profiles = [], isNew = false, parentId = null }) {
  const scope = (() => {
    try { return JSON.parse(doc?.profile_scope || 'null') || []; } catch { return []; }
  })();

  return `
<div class="head">
  <a class="crumb" href="${doc ? `/docs/${esc(doc.slug)}` : '/docs'}">${doc ? 'Cancel' : 'Documentation'}</a>
  <h1>${isNew ? 'New page' : 'Editing'}</h1>
</div>

<form class="editor" data-did="${esc(doc?.id || '')}" data-new="${isNew ? '1' : '0'}">
  <label class="lb" for="d-title">Title</label>
  <input id="d-title" data-field="doc-title" type="text" maxlength="120"
         value="${esc(doc?.title || '')}" placeholder="How my skips work" required>

  <div class="pair">
    <div>
      <label class="lb" for="d-parent">Folder</label>
      <select id="d-parent" data-field="doc-parent">
        <option value="">No folder</option>
        ${folders.map((f) => `<option value="${esc(f.id)}"${
          (doc?.parent_id || parentId) === f.id ? ' selected' : ''}>${esc(f.title)}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="lb" for="d-kind">Kind</label>
      <select id="d-kind" data-field="doc-folder"${doc ? ' disabled' : ''}>
        <option value="0"${doc?.is_folder ? '' : ' selected'}>Page</option>
        <option value="1"${doc?.is_folder ? ' selected' : ''}>Folder</option>
      </select>
    </div>
  </div>

  <fieldset class="scope">
    <legend class="lb">Who sees this</legend>
    <label class="check"><input type="radio" name="scope" value="all" data-field="doc-scope"
      ${scope.length ? '' : 'checked'}> Every profile</label>
    ${profiles.map((p) => `<label class="check"><input type="checkbox" data-field="doc-profile"
      value="${esc(p.id)}"${scope.includes(p.id) ? ' checked' : ''}> Only ${esc(p.name)}</label>`).join('')}
  </fieldset>

  <div class="iconpick" ${doc && !doc.is_folder ? 'hidden' : ''}>
    <span class="lb">Icon</span>
    ${FOLDER_ICONS.map((n) => `<label class="ipick">
      <input type="radio" name="docicon" value="${n}" data-field="doc-icon"
        ${(doc?.icon || 'folder') === n ? 'checked' : ''}>
      <span aria-hidden="true">${icon(n)}</span><span class="vh">${n}</span>
    </label>`).join('')}
  </div>

  <div class="mdbar" role="toolbar" aria-label="Formatting">
    <button type="button" data-md="bold" aria-label="Bold" title="Bold"><b>B</b></button>
    <button type="button" data-md="italic" aria-label="Italic" title="Italic"><i>I</i></button>
    <button type="button" data-md="h2" aria-label="Heading" title="Heading">H</button>
    <button type="button" data-md="quote" aria-label="Quote" title="Quote">&ldquo;</button>
    <button type="button" data-md="code" aria-label="Code" title="Code">&lt;&gt;</button>
    <button type="button" data-md="ul" aria-label="Bulleted list" title="Bulleted list">&bull;</button>
    <button type="button" data-md="ol" aria-label="Numbered list" title="Numbered list">1.</button>
    <button type="button" data-md="link" aria-label="Link" title="Link">&#128279;</button>
    <span class="tabs">
      <button type="button" class="on" data-tab="write">Write</button>
      <button type="button" data-tab="preview">Preview</button>
    </span>
  </div>

  <label class="lb vh" for="d-body">Content</label>
  <textarea id="d-body" data-field="doc-body" class="mdbody" rows="22"
    placeholder="Write in markdown, or ignore the syntax and use the buttons.">${esc(doc?.body_md || '')}</textarea>
  <div class="prose preview" id="d-preview" hidden></div>

  <div class="acts">
    <button type="button" class="go" data-act="save-doc">Save</button>
    <a class="btn" href="${doc ? `/docs/${esc(doc.slug)}` : '/docs'}">Cancel</a>
    ${doc ? `<a class="btn pushright" href="/api/docs/${esc(doc.id)}/export">Export as .md</a>` : ''}
  </div>
</form>`;
}
