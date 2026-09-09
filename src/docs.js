// Documentation: your own pages, written in the dashboard.
//
// A folder is a document with is_folder = 1. One table, one CRUD path, one
// delete path, one scoping rule — rather than two of each for what is one idea.
//
// MARKDOWN IS RENDERED ONCE, ON SAVE, and the HTML is stored beside the source.
// Viewing a page then parses nothing. The preview endpoint calls the same
// function, so what you see while writing cannot drift from what is saved.
//
// SAFETY IS BY CONSTRUCTION, NOT BY SANITISER. The source is HTML-escaped
// BEFORE it reaches the parser, so a <script> in a document can only ever come
// out as text. That is not quite enough on its own: marked will happily emit
// <a href="javascript:..."> from ordinary markdown link syntax, which escaping
// does nothing about — so links and images are also filtered to http, https and
// mailto. Both halves are tested.

import { marked } from 'marked';
import { newId, nowIso } from './entity.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Only schemes that cannot execute. Anything else loses its href entirely. */
function safeHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  // Relative and anchor links are fine and cannot carry a scheme.
  if (/^[#/]/.test(raw)) return raw;
  return /^(?:https?:|mailto:)/i.test(raw) ? raw : null;
}

const renderer = {
  link({ href, title, text }) {
    const safe = safeHref(href);
    // A blocked link keeps its words and loses its destination, rather than
    // vanishing — deleting a person's text to make a page safe is worse.
    if (!safe) return `<span class="dead-link" title="unsupported link">${text}</span>`;
    const t = title ? ` title="${esc(title)}"` : '';
    const external = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${esc(safe)}"${t}${external}>${text}</a>`;
  },
  image({ href, title, text }) {
    const safe = safeHref(href);
    if (!safe) return esc(text || '');
    return `<img src="${esc(safe)}" alt="${esc(text || '')}"${title ? ` title="${esc(title)}"` : ''}>`;
  },
};

marked.use({ renderer, gfm: true, breaks: false });

/** Markdown to HTML that cannot execute. Escape first, then parse. */
export function renderMarkdown(md) {
  return marked.parse(esc(md || ''));
}

export const slugify = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Does this profile see this document?
 *
 * NULL scope means every profile — the common case, and the default, because
 * most of what gets written down is about how the whole thing works rather than
 * about one operation.
 */
export function visibleTo(doc, profileId) {
  if (!doc?.profile_scope) return true;
  try {
    const scope = JSON.parse(doc.profile_scope);
    return !Array.isArray(scope) || !scope.length || scope.includes(profileId);
  } catch {
    return true;
  }
}

export async function listDocs(db, profileId) {
  const { results } = await db.prepare(
    'SELECT * FROM docs ORDER BY is_folder DESC, position, title'
  ).all();
  return (results || []).filter((d) => visibleTo(d, profileId));
}

/** The sidebar tree: folders, each with the documents inside it, plus loose ones. */
export async function docTree(db, profileId) {
  const all = await listDocs(db, profileId);
  const folders = all.filter((d) => d.is_folder)
    .map((f) => ({ ...f, docs: all.filter((d) => !d.is_folder && d.parent_id === f.id) }));
  const loose = all.filter((d) => !d.is_folder && !folders.some((f) => f.id === d.parent_id));
  return { folders, loose, count: all.length };
}

export async function getDoc(db, profileId, slug) {
  const row = await db.prepare('SELECT * FROM docs WHERE slug = ?').bind(slug).first();
  if (!row || !visibleTo(row, profileId)) return null;
  return row;
}

export async function saveDoc(db, { id, parentId, isFolder, title, bodyMd, icon, scope }) {
  const clean = String(title || '').trim().slice(0, 120);
  if (clean.length < 2) return { ok: false, error: 'give it a title' };

  const md = String(bodyMd ?? '').slice(0, 200000);
  const html = isFolder ? null : renderMarkdown(md);
  const ts = nowIso();
  // NULL is every profile. An empty array would mean "no profiles", which is a
  // document nobody can read.
  const scopeJson = Array.isArray(scope) && scope.length ? JSON.stringify(scope) : null;

  if (id) {
    const res = await db.prepare(
      `UPDATE docs SET title = ?, body_md = ?, body_html = ?, icon = COALESCE(?, icon),
              parent_id = ?, profile_scope = ?, updated_at = ? WHERE id = ?`
    ).bind(clean, md, html, icon || null, parentId || null, scopeJson, ts, id).run();
    if (!res?.meta?.changes) return { ok: false, error: 'not-found' };
    return { ok: true, id };
  }

  const base = slugify(clean) || 'page';
  let slug = base;
  for (let n = 2; await db.prepare('SELECT id FROM docs WHERE slug = ?').bind(slug).first(); n++) {
    slug = `${base}-${n}`;
  }
  const next = await db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 AS n FROM docs WHERE COALESCE(parent_id, '') = ?"
  ).bind(parentId || '').first();

  const newRow = newId();
  await db.prepare(
    `INSERT INTO docs (id, parent_id, is_folder, title, slug, icon, body_md, body_html,
                       position, profile_scope, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(newRow, parentId || null, isFolder ? 1 : 0, clean, slug, icon || null,
    md, html, next?.n || 1, scopeJson, ts, ts).run();
  return { ok: true, id: newRow, slug };
}

/**
 * Delete a page, or a folder and everything in it.
 *
 * The count comes back so the confirmation can say "and the 4 documents inside
 * it" rather than letting a folder delete look like a page delete.
 */
export async function deleteDoc(db, id) {
  const row = await db.prepare('SELECT * FROM docs WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: 'not-found' };

  let children = 0;
  if (row.is_folder) {
    const c = await db.prepare('SELECT COUNT(*) AS n FROM docs WHERE parent_id = ?').bind(id).first();
    children = c?.n || 0;
    await db.prepare('DELETE FROM docs WHERE parent_id = ?').bind(id).run();
  }
  await db.prepare('DELETE FROM docs WHERE id = ?').bind(id).run();
  return { ok: true, title: row.title, children };
}

/** What a folder holds, for the folder page and for a delete confirmation. */
export async function childrenOf(db, profileId, id) {
  const { results } = await db.prepare(
    'SELECT * FROM docs WHERE parent_id = ? ORDER BY position, title'
  ).bind(id).all();
  return (results || []).filter((d) => visibleTo(d, profileId));
}
