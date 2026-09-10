// The UI, in a real browser.
//
// Everything else in test/ runs server-side, which is exactly where the worst
// bug of this project hid: an escape consumed by a template literal emitted a
// syntax error into the page, every handler died, and every server-side check
// stayed green. A rendered string is not a working page.
//
// Not part of `pnpm test` — it needs a dev server and a browser. Run it with:
//   pnpm run dev:test      (in one shell)
//   pnpm run test:seed      (fixture data, dated relative to today)
//   pnpm run test:browser

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const KEY = (readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .match(/^DASHBOARD_KEY=(.*)$/m) || [])[1].trim().replace(/^["']|["']$/g, '');

const pass = [];
const fail = [];
const check = (cond, what) => (cond ? pass : fail).push(what);

const browser = await chromium.launch();
const page = await browser.newPage();

// A page error is a failure on its own: it means some handler is dead.
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const go = async (path) => page.goto(BASE + path, { waitUntil: 'networkidle' });

await page.goto(`${BASE}/?key=${encodeURIComponent(KEY)}`, { waitUntil: 'networkidle' });
check(!/Set up/.test(await page.title()), 'the dashboard loads with a profile');

// ---------------------------------------------------------------------------
// Settings is a modal over the page, not a slab at the bottom of it
// ---------------------------------------------------------------------------
const settings = page.locator('#settings');
check(await settings.isHidden(), 'settings is hidden until it is opened');
await page.locator('[data-act="open-settings"]').click();
check(await settings.evaluate((d) => d.matches(':modal')), 'settings opens as a modal');
await page.locator('[data-panel="categories"]').click();
check(await page.locator('#panel-categories').isVisible(), 'panels switch');
await page.keyboard.press('Escape');
check(await settings.isHidden(), 'Escape closes it');

// ---------------------------------------------------------------------------
// A sheet holds the page still. A wheel over the backdrop was scrolling the
// list underneath, so closing the sheet left you somewhere else entirely.
// ---------------------------------------------------------------------------
const locked = () => page.evaluate(() => getComputedStyle(document.documentElement).overflow === 'hidden');
const scrollY = () => page.evaluate(() => window.scrollY);
const wheelAt = async (x, yy, dy) => {
  await page.mouse.move(x, yy); await page.mouse.wheel(0, dy); await page.waitForTimeout(200);
};

await go('/skipped');
check(!(await locked()), 'the page scrolls normally with no sheet open');
await wheelAt(550, 400, 300);
check((await scrollY()) > 0, 'and really does scroll');

await page.locator('[data-act="open-categories"]').click();
await page.waitForTimeout(250);
const held = await scrollY();
await wheelAt(40, 300, 600);
check((await scrollY()) === held, 'a wheel over the backdrop leaves the page where it was');

// The settings sheet still scrolls its own content.
const paneMoved = await page.evaluate(async () => {
  const pane = document.querySelector('.spanes');
  if (!pane || pane.scrollHeight <= pane.clientHeight) return 'no overflow to test';
  pane.scrollTop = 150;
  return pane.scrollTop > 0;
});
check(paneMoved === true || paneMoved === 'no overflow to test',
  `the sheet scrolls its own content (${paneMoved})`);

// The confirm opens ON TOP of settings — a JS counter would unlock here.
await page.locator('[data-act="del-category"]').first().click();
await page.waitForTimeout(250);
check(await locked(), 'still locked with a confirm stacked on settings');
await page.locator('#confirm-no').click();
await page.waitForTimeout(250);
check(await locked(), 'and still locked when only the confirm closes');

await page.keyboard.press('Escape');
await page.waitForTimeout(250);
check(!(await locked()), 'unlocked once every sheet is closed');
await wheelAt(550, 400, 300);
check((await scrollY()) > held, 'and the page scrolls again afterwards');

// ---------------------------------------------------------------------------
// Switching profile actually switches
// ---------------------------------------------------------------------------
await Promise.all([page.waitForURL('**/*profile=clinics*'), page.selectOption('#profile', 'clinics')]);
check(page.url().includes('profile=clinics'), 'the profile switcher navigates');
const heading = await page.locator('#profile').inputValue();
check(heading === 'clinics', 'and lands on the profile it chose');
await go('/?profile=ceramics');

// ---------------------------------------------------------------------------
// Pagination and search
// ---------------------------------------------------------------------------
await go('/sent');
check((await page.locator('.row[data-oid]').count()) === 20, 'a page holds 20 rows');
await Promise.all([page.waitForURL('**page=2**'), page.locator('.pnum[data-page="2"]').first().click()]);
check(await page.locator('.pnum.on').first().textContent() === '2', 'page 2 is marked current');
await go('/sent?q=Portland');
const found = await page.locator('.row[data-oid]').count();
check(found > 0 && found <= 20, `searching a location finds rows (${found})`);

// ---------------------------------------------------------------------------
// The bounce drawer — the field-name collision lived exactly here
// ---------------------------------------------------------------------------
await go('/sent');
await page.locator('[data-open="bounce"]').first().click();
const bounceBox = page.locator('.drawer[data-drawer="bounce"] textarea').first();
check(await bounceBox.isVisible(), 'the bounce drawer opens');
const markBounced = page.locator('[data-act="bounce"]').first();
check(await markBounced.isDisabled(), 'its button waits until the box says something');
await bounceBox.fill('mailer-daemon: 550 user unknown');
check(await markBounced.isEnabled(), 'and enables once it does');
// the notes pill must NOT be what the button reads
const noteValue = await page.locator('.npill').first().inputValue();
check(noteValue === '', 'the notes pill is untouched and separate');

// ---------------------------------------------------------------------------
// Skipping asks for a reason before it will go
// ---------------------------------------------------------------------------
await go('/');
if (await page.locator('[data-open="reason"]').count()) {
  await page.locator('[data-open="reason"]').first().click();
  const skipBtn = page.locator('[data-act="skip"]').first();
  check(await skipBtn.isDisabled(), 'skipping is refused with no reason');
  await page.locator('.drawer[data-drawer="reason"] textarea').first().fill('their site is already good');
  check(await skipBtn.isEnabled(), 'and allowed once one is given');
} else { check(false, "today's queue has a draft to skip"); }

// ---------------------------------------------------------------------------
// Documentation: read, edit, preview, and a delete that asks first
// ---------------------------------------------------------------------------
await go('/docs');
check((await page.locator('.rail').getAttribute('data-mode')) === 'docs', 'the rail slides to docs');
check(await page.locator('[data-act="open-settings"]').isVisible(), 'settings stays pinned');
await go('/docs/skips');
check((await page.locator('.prose h2').count()) > 0, 'a page renders its markdown');

await go('/docs/skips?edit=1');
await page.locator('#d-body').fill('one\ntwo');
await page.locator('#d-body').selectText();
await page.locator('[data-md="ul"]').click();
check(await page.locator('#d-body').inputValue() === '- one\n- two', 'the list button prefixes each line');
await page.locator('[data-tab="preview"]').click();
await page.waitForTimeout(700);
check((await page.locator('#d-preview').innerHTML()).includes('<li>'), 'preview renders server-side');

await go('/docs/skips');
await page.locator('[data-act="del-doc"]').first().click();
const confirm = page.locator('#confirm');
check(await confirm.evaluate((d) => d.matches(':modal')), 'deleting asks first, in a modal');
check(await page.evaluate(() => document.activeElement?.id) === 'confirm-no',
  'with focus on the safe answer');
await page.locator('#confirm-no').click();
await go('/docs/skips');
check((await page.locator('.prose').count()) > 0, 'saying No left the page alone');

// ---------------------------------------------------------------------------
// Creating and deleting a skip category, for real
// ---------------------------------------------------------------------------
await go('/skipped');
await page.locator('[data-act="open-categories"]').click();
const before = await page.locator('.cat').count();
await page.locator('#ncname').fill('Browser test category');
await page.locator('#ncdef').fill('Made by the browser test.');
await page.locator('#catcreate').click();
await page.waitForTimeout(1400);
await go('/skipped');
await page.locator('[data-act="open-categories"]').click();
const after = await page.locator('.cat').count();
check(after === before + 1, `a category can be created (${before} -> ${after})`);

const target = page.locator('.cat', { hasText: 'Browser test category' }).first();
await target.locator('[data-act="del-category"]').click();
await page.locator('#confirm-yes').click();
await page.waitForTimeout(1400);
await go('/skipped');
await page.locator('[data-act="open-categories"]').click();
check((await page.locator('.cat').count()) === before, 'and deleted again');

// ---------------------------------------------------------------------------
// Metrics, including a specific past day
// ---------------------------------------------------------------------------
await go('/metrics?period=all');
check((await page.locator('.card').count()) > 4, 'metrics renders');
await go('/metrics?period=day&day=2026-08-05');
check((await page.locator('.head .dim').first().textContent()).includes('2026-08-05'),
  'metrics can show one named day');

check(errors.length === 0, `no page errors anywhere (${[...new Set(errors)].join(' | ') || 'none'})`);

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
for (const p of pass) console.log('  ok   ', p);
for (const f of fail) console.log('  FAIL ', f);
await browser.close();
process.exit(fail.length ? 1 : 0);
