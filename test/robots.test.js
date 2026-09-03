import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed } from '../src/fetcher.js';

const UA = 'LeadFinderBot/0.1 (+https://example.com/bot)';

test('empty robots allows everything', () => {
  assert.ok(isAllowed(parseRobots('', UA), '/anything'));
});

test('wildcard disallow is honoured', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /admin\n', UA);
  assert.equal(isAllowed(rules, '/admin/settings'), false);
  assert.equal(isAllowed(rules, '/shop'), true);
});

test('a block naming our bot wins over the wildcard block', () => {
  const txt = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: LeadFinderBot',
    'Disallow: /private',
  ].join('\n');
  const rules = parseRobots(txt, UA);
  assert.equal(isAllowed(rules, '/shop'), true);
  assert.equal(isAllowed(rules, '/private/x'), false);
});

test('Disallow: / blocks the whole site', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /', UA);
  assert.equal(isAllowed(rules, '/'), false);
  assert.equal(isAllowed(rules, '/shop'), false);
});

test('empty Disallow means allow all', () => {
  const rules = parseRobots('User-agent: *\nDisallow:', UA);
  assert.equal(isAllowed(rules, '/anything'), true);
});

test('longest match wins and Allow beats Disallow at equal length', () => {
  const rules = parseRobots(
    'User-agent: *\nDisallow: /shop\nAllow: /shop/public\n', UA
  );
  assert.equal(isAllowed(rules, '/shop/private'), false);
  assert.equal(isAllowed(rules, '/shop/public/item'), true);
});

test('wildcards and end-anchors are supported', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$\n', UA);
  assert.equal(isAllowed(rules, '/files/report.pdf'), false);
  assert.equal(isAllowed(rules, '/files/report.pdf?x=1'), true);
  assert.equal(isAllowed(rules, '/files/report.html'), true);
});

test('comments and blank lines are ignored', () => {
  const rules = parseRobots('# hi\nUser-agent: *  # all\nDisallow: /x # nope\n', UA);
  assert.equal(isAllowed(rules, '/x/y'), false);
});
