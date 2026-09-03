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
