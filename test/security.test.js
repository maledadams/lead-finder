import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicHost } from '../src/fetcher.js';

test('SSRF guard blocks internal and metadata addresses', () => {
  // A hostile page in the crawl frontier could link to any of these to make
  // the Worker fetch them on its behalf.
  for (const bad of [
    'localhost', '127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.1',
    '172.16.0.1', '172.31.255.254', '169.254.169.254',  // cloud metadata
    'metadata.google.internal', 'instance-data', 'db.internal', 'printer.local',
    '::1', '[::1]', 'router', 'intranet',
  ]) {
    assert.equal(isPublicHost(bad), false, `should block ${bad}`);
  }
});

test('SSRF guard allows ordinary public hosts', () => {
  for (const good of [
    'example.com', 'www.brand.co.uk', 'shop.mothandmoon.studio',
    '172.32.0.1',            // just outside the private 172.16/12 range
    '11.0.0.1',              // not 10.x
  ]) {
    assert.equal(isPublicHost(good), true, `should allow ${good}`);
  }
});

test('auth comparison is length-safe and constant-time in shape', async () => {
  // Reach the non-exported helper through the module's own behaviour: a
  // wrong-length key must never be treated as a prefix match.
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));

  assert.match(src, /a\.length !== b\.length/, 'must reject on length mismatch');
  assert.match(src, /diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/, 'must XOR every char');
  assert.ok(!/provided === expected|provided == expected/.test(src), 'no short-circuit compare');
});

test('auth fails closed when the secret is missing', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.match(src, /if \(!expected\) return false/, 'no secret must mean no access');
});

test('every response carries the security headers', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  for (const h of [
    'referrer-policy', 'x-content-type-options', 'x-frame-options',
    'strict-transport-security', 'permissions-policy',
  ]) {
    assert.ok(src.includes(h), `missing ${h}`);
  }
  // Both the JSON helper and the 429 path must spread them.
  assert.equal((src.match(/\.\.\.SECURITY_HEADERS/g) || []).length >= 3, true);
});

test('the CSP has no unsafe script directive', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(src), "script-src must not allow 'unsafe-inline'");
  assert.ok(!/unsafe-eval/.test(src), "must not allow 'unsafe-eval'");
  assert.match(src, /script-src 'nonce-/, 'scripts must be nonce-gated');
});

test('the dashboard has no inline event handlers for CSP to block', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8'));
  assert.ok(!/\son[a-z]+\s*=\s*["']/.test(src), 'inline handlers would be blocked by the nonce CSP');
});

/**
 * A data: URI in an HTML attribute must not carry a raw quote.
 *
 * The favicon shipped once percent-encoded with `"` left in the safe set, so
 * `href="data:image/svg+xml,<svg xmlns="` closed the attribute on its own
 * second quote: the icon never loaded and the rest of the SVG leaked into the
 * page as visible text. Base64 has no character that can break out, and this
 * asserts it stays that way.
 */
test('the favicon data URI cannot break out of its attribute', async () => {
  const { renderDashboard } = await import('../src/dashboard.js');
  const db = {
    prepare: () => {
      const first = async () => ({ todo: 0, sent: 0, skipped: 0, bounced: 0, contacted: 0 });
      const all = async () => ({ results: [] });
      return { first, all, bind: () => ({ first, all }) };
    },
  };
  const html = await renderDashboard(db, {}, {
    view: 'today', nonce: 'n', signedInAs: null, sending: null,
    day: '2026-09-08', page: 1, q: '', from: null, to: null,
  });

  const icons = html.match(/<link rel="icon" href="([^"]*)">/g) || [];
  assert.equal(icons.length, 1, 'exactly one icon link');

  const href = html.match(/<link rel="icon" href="([^"]*)">/)[1];
  assert.match(href, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/, 'base64 only — no raw markup');
  assert.match(Buffer.from(href.split(',')[1], 'base64').toString(), /^<svg[\s\S]*<\/svg>$/);

  // Nothing may sit between the head tags except the title and the theme script.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(!/["']\s*>\s*["']/.test(head), 'no attribute-breakout debris in the head');
  assert.ok(!head.includes('<svg'), 'the svg must stay inside the data URI, not in the markup');
});
