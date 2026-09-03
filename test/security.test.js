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
