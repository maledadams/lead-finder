import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, splitFooter, buildHtmlBody, buildTextBody } from '../src/zoho.js';
import { composeDraft } from '../src/outreach.js';
import { setResponseStatus, sweepGhosted, RESPONSE_STATUSES } from '../src/queue.js';

const env = { SENDER_POSTAL_ADDRESS: '12 Bell Row, Bristol BS1 4TY', SENDER_NAME: 'Lucía Adams' };

const FIRMA = `<div><b>Lucía Adams</b><br>Designer &amp; developer<br>
<a href="https://maledadams.work">maledadams.work</a><br>
<a href="mailto:hi@maledadams.work">hi@maledadams.work</a></div>`;

// ---------------------------------------------------------------------------
// The firma, flattened
// ---------------------------------------------------------------------------

test('htmlToText keeps the link target when the label is not the url', () => {
  const out = htmlToText(FIRMA);
  assert.match(out, /Lucía Adams/);
  assert.match(out, /Designer & developer/);
  // A bare domain label already contains its url, so it is not duplicated.
  assert.match(out, /maledadams\.work/);
  assert.doesNotMatch(out, /</, 'no tags may survive');
  assert.doesNotMatch(out, /&amp;|&nbsp;/, 'entities must be decoded');
});

test('htmlToText spells out a url hidden behind a text label', () => {
  assert.equal(htmlToText('<a href="https://example.com/x">our work</a>'), 'our work (https://example.com/x)');
});

test('htmlToText drops script and style content entirely', () => {
  assert.equal(htmlToText('<style>a{color:red}</style><p>Hi</p><script>alert(1)</script>'), 'Hi');
});

test('htmlToText is safe on empty input', () => {
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(''), '');
});

// ---------------------------------------------------------------------------
// Where the firma goes
// ---------------------------------------------------------------------------

test('splitFooter separates the message from the legal footer', () => {
  const draft = composeDraft({
    id: 'e1', display_name: 'Fenwick & Ash', contact_email: 'hi@fenwickash.co.uk',
    niche: 'craft_goods', website_opportunity: 'no online ordering',
    personalization: '{"liked":"the ash-glaze series"}',
  }, env);
  assert.ok(draft, 'a draft should compose');

  const { message, footer } = splitFooter(draft.body);
  assert.match(footer, /I will not write again/);
  assert.match(footer, /12 Bell Row/);
  assert.doesNotMatch(message, /I will not write again/);
  // The sign-off the user asked for sits at the end of the message, above the footer.
  assert.match(message, /Best,\nLucía Adams$/);
});

test('splitFooter tolerates a body with no footer at all', () => {
  assert.deepEqual(splitFooter('Just a line'), { message: 'Just a line', footer: '' });
});

test('the draft names the business rather than announcing an observation', () => {
  const draft = composeDraft({
    id: 'e1', display_name: 'Fenwick & Ash', contact_email: 'hi@fenwickash.co.uk',
    niche: 'craft_goods', website_opportunity: 'no online ordering',
    personalization: '{"liked":"the ash-glaze series"}',
  }, env);
  assert.match(draft.body, /Fenwick & Ash could benefit from/);
  assert.doesNotMatch(draft.body, /one thing stood out/i);
});

// ---------------------------------------------------------------------------
// The two send shapes
// ---------------------------------------------------------------------------

test('buildHtmlBody escapes the draft but keeps the firma as authored', () => {
  const html = buildHtmlBody('Hi <script>x</script>\n\nIf this is not relevant, reply.\n12 Bell Row', FIRMA);
  assert.match(html, /&lt;script&gt;/, 'the draft must be escaped');
  assert.doesNotMatch(html, /<script>/, 'no raw script from the draft');
  assert.match(html, /<b>Lucía Adams<\/b>/, 'the firma keeps its markup');
  assert.match(html, /<br>/, 'line breaks survive as <br>');
  assert.match(html, /border-top/, 'the footer is set apart');
});

test('buildHtmlBody still produces a whole message with no signature', () => {
  const html = buildHtmlBody('Hello\n\nIf this is not relevant, reply.', null);
  assert.match(html, /Hello/);
  assert.match(html, /If this is not relevant/);
});

test('buildTextBody puts the flattened firma above the footer', () => {
  const body = 'Hello,\n\nSome text.\n\nBest,\nLucía Adams\n\nIf this is not relevant, reply.\n12 Bell Row';
  const out = buildTextBody(body, FIRMA);
  const firmaAt = out.indexOf('Designer & developer');
  const footerAt = out.indexOf('If this is not relevant');
  assert.ok(firmaAt > 0, 'the firma must appear');
  assert.ok(firmaAt < footerAt, 'and it must sit above the legal footer');
  assert.doesNotMatch(out, /</, 'plaintext must carry no markup');
});

test('buildTextBody returns the body untouched when there is no signature', () => {
  assert.equal(buildTextBody('Hello', null), 'Hello');
});

// ---------------------------------------------------------------------------
// Reply status and ghosting
// ---------------------------------------------------------------------------

function stubDb(row) {
  const calls = [];
  const mk = (sql, args = []) => ({
    sql, args,
    first: async () => row,
    run: async () => { calls.push({ sql, args }); return { meta: { changes: 1 } }; },
  });
  return { calls, prepare: (sql) => ({ ...mk(sql), bind: (...a) => mk(sql, a) }) };
}
const sqlOf = (db) => db.calls.map((c) => c.sql.replace(/\s+/g, ' ')).join(' || ');

test('marking a lead replied advances it out of CONTACTED', async () => {
  const db = stubDb({ state: 'CONTACTED' });
  const res = await setResponseStatus(db, 'e1', 'REPLIED');
  assert.equal(res.ok, true);
  assert.match(sqlOf(db), /state = 'REPLIED'/);
});

test('clearing the status brings a replied lead back to CONTACTED', async () => {
  const db = stubDb({ state: 'REPLIED' });
  await setResponseStatus(db, 'e1', null);
  assert.match(sqlOf(db), /state = 'CONTACTED'/);
});

test('status never drags a lead backwards out of the funnel', async () => {
  for (const state of ['CONVERSATION', 'CLIENT']) {
    const db = stubDb({ state });
    await setResponseStatus(db, 'e1', 'REPLIED');
    assert.doesNotMatch(sqlOf(db), /state =/, `${state} must be left alone`);
  }
});

test('an unknown status is refused', async () => {
  const db = stubDb({ state: 'CONTACTED' });
  const res = await setResponseStatus(db, 'e1', 'MAYBE');
  assert.equal(res.ok, false);
  assert.match(res.error, /REPLIED/);
  assert.deepEqual(RESPONSE_STATUSES, ['REPLIED', 'NO_REPLY', 'GHOSTED']);
});

test('the ghost sweep only fills in a blank status', async () => {
  const db = stubDb({});
  const res = await sweepGhosted(db, 30);
  assert.equal(res.ok, true);
  const sql = sqlOf(db);
  // A status set by hand must survive the sweep, and nothing else may change.
  assert.match(sql, /response_status IS NULL/);
  assert.match(sql, /state = 'CONTACTED'/);
  assert.doesNotMatch(sql, /DO_NOT_CONTACT|DELETE|contact_email/);
});

// ---------------------------------------------------------------------------
// "could benefit from" has to stay grammatical
// ---------------------------------------------------------------------------

test('benefitOf turns each mapped finding into something that reads as an upside', async () => {
  const { benefitOf } = await import('../src/outreach.js');
  const cases = [
    ['no online ordering', /^online ordering$/],
    ['sells sessions or commissions with no booking flow on the site', /book you straight from the site/],
    ['orders taken manually by DM or email', /proper checkout/],
    ['no mobile viewport meta tag present', /works properly on phones/],
    ['Squarespace template with limited design control', /Squarespace template/],
    ['copyright still reads 2019', /no longer says 2019/],
  ];
  for (const [raw, expected] of cases) {
    const b = benefitOf(raw);
    assert.ok(b, `${raw} should map to a benefit`);
    assert.match(b, expected);
    // The whole point: it must not still be phrased as a lack.
    assert.doesNotMatch(b, /^(no|missing|lacks|without)\b/i);
  }
});

test('benefitOf always yields something that reads after "could benefit from"', async () => {
  const { benefitOf } = await import('../src/outreach.js');
  // "could benefit from" is the permanent phrasing now, so this must be total —
  // a null would leave a sentence with a hole in it.
  assert.equal(benefitOf('a booking flow for workshops'), 'a booking flow for workshops');
  // A clause-shaped finding is nudged into a noun phrase rather than dropped.
  assert.match(benefitOf('there is no way to book you from the site'), /^(?:some work on |way to book)/);
  // Nothing in, nothing out.
  assert.equal(benefitOf(''), null);
  assert.equal(benefitOf(null), null);
});

test('every draft uses "could benefit from", whatever the finding', async () => {
  const { composeDraft } = await import('../src/outreach.js');
  const draft = composeDraft({
    id: 'e1', display_name: 'Fenwick & Ash', contact_email: 'hi@x.co', niche: 'craft_goods',
    website_opportunity: 'a booking flow for workshops',
    personalization: '{"liked":"the ash-glaze series"}',
  }, env);
  assert.match(draft.body, /Fenwick & Ash could benefit from a booking flow for workshops\./);
  assert.doesNotMatch(draft.body, /one thing stood out/i, 'the old phrasing is gone for good');
});

// ---------------------------------------------------------------------------
// The shape every email now has.
// ---------------------------------------------------------------------------

const draftFor = async (opp, extra = {}) => {
  const { composeDraft } = await import('../src/outreach.js');
  return composeDraft({
    id: 'e1', display_name: 'Here We Go Again', contact_email: 'a@b.co',
    niche: 'craft_goods', website_opportunity: opp, personalization: '{}', ...extra,
  }, env);
};

test('the throat-clearing opener is gone from every draft', async () => {
  for (const opp of ['orders taken manually by DM or email', 'no meta description']) {
    const d = await draftFor(opp, { personalization: '{"liked":"the tin-glaze bowls"}' });
    assert.doesNotMatch(d.body, /I came across/i, 'the filler opener must not return');
    assert.doesNotMatch(d.body, /spent (?:a while|some time) on your site/i);
    // The email opens on who is writing.
    assert.match(d.body.split('\n')[2], /^I'm /);
  }
});

test('nothing is promised and nothing is offered for free', async () => {
  const d = await draftFor('orders taken manually by DM or email');
  for (const promise of [/free/i, /no expectation/i, /send it over/i, /would you like me to/i]) {
    assert.doesNotMatch(d.body, promise, `must not promise: ${promise}`);
  }
  assert.match(d.body, /reply and I will take a proper look/);
});

test('every email states the problem, the cost, and the fix', async () => {
  const d = await draftFor('orders taken manually by DM or email');
  assert.match(d.body, /could benefit from a proper checkout/, 'the problem, as an upside');
  assert.match(d.body, /Every order costs you a conversation/, 'what it costs them now');
  assert.match(d.body, /The fix is a real checkout/, 'what fixing it involves');
});

test('a compliment reads correctly whether it is singular or plural', async () => {
  // "The tin-glaze bowls is what made me look" was the bug.
  const plural = await draftFor('no meta description', { personalization: '{"liked":"the tin-glaze bowls"}' });
  const singular = await draftFor('no meta description', { personalization: '{"liked":"the layered denim capsule"}' });
  assert.match(plural.body, /I stopped on the tin-glaze bowls\./);
  assert.match(singular.body, /I stopped on the layered denim capsule\./);
  assert.doesNotMatch(plural.body, /bowls is what/);
});

test('a business with no website gets the same shape', async () => {
  const { composeDraft } = await import('../src/outreach.js');
  const d = composeDraft({
    id: 'e1', display_name: 'Halcyon Bindery', contact_email: 'a@b.co', niche: 'craft_goods',
    personalization: '{"no_website":true}', instagram: 'halcyon',
  }, env);
  assert.match(d.body, /Halcyon Bindery could benefit from a site of its own/);
  assert.doesNotMatch(d.body, /free/i);
  assert.match(d.body, /reply and I will take a proper look/);
});
