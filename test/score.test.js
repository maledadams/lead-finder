import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals, guessNiche } from '../src/extract.js';
import { hardFilter, deterministicScore, finalScore } from '../src/score.js';
import { selectPeerLinks } from '../src/discover.js';
import { NICHES, DEFAULT_NICHE } from '../src/config.js';

const goodBrand = `<!doctype html><html><head>
<title>Moth &amp; Moon — handmade ceramics</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Small-batch stoneware made in Portland, OR 97209">
<meta property="og:site_name" content="Moth &amp; Moon">
<script src="https://cdn.shopify.com/s/files/x.js"></script>
<script src="https://static.klaviyo.com/onsite.js"></script>
</head><body>
<a href="/collections/vases">Vases</a><a href="/collections/mugs">Mugs</a>
<a href="/collections/bowls">Bowls</a><a href="/collections/plates">Plates</a>
<a href="/products/ash-vase">Ash Vase $180</a>
<a href="/products/moon-mug">Moon Mug $64</a>
<a href="/products/bowl">Bowl $92</a>
<a href="/cart">Cart</a>
<a href="https://instagram.com/mothandmoon">Instagram</a>
<a href="https://www.etsy.com/shop/MothAndMoon">Etsy</a>
<a href="/pages/stockists">Stockists</a>
<a href="/blog">Journal</a>
<a href="mailto:sasha@mothandmoon.com">sasha@mothandmoon.com</a>
<img src="a.jpg" srcset="a.jpg 1x, a2.jpg 2x" loading="lazy" width="800" height="600">
<img src="b.jpg" srcset="b.jpg 1x" loading="lazy" width="800" height="600">
<img src="c.jpg" srcset="c.jpg 1x" loading="lazy" width="800" height="600">
<img src="d.jpg" srcset="d.jpg 1x" loading="lazy" width="800" height="600">
<img src="e.jpg" srcset="e.jpg 1x" loading="lazy" width="800" height="600">
<img src="f.jpg" srcset="f.jpg 1x" loading="lazy" width="800" height="600">
<button>Add to cart</button>
<p>As seen in Vogue. Meet the team behind our studio. ${'Hand thrown stoneware for slow mornings. '.repeat(30)}</p>
<p>Subscribe to our newsletter. Wholesale enquiries welcome.</p>
<footer>© 2026 Moth &amp; Moon, Portland, OR 97209</footer>
</body></html>`;

const brokenBrand = `<!doctype html><html><head><title>Ash Studio</title></head><body>
<p>${'We make jewelry by hand in our studio. DM us to order any piece. '.repeat(20)}</p>
${Array.from({ length: 18 }, (_, i) => `<img src="${i}.jpg">`).join('')}
<footer>© 2019 Ash Studio</footer></body></html>`;

test('extractSignals reads platform, commerce and power signals', () => {
  const s = extractSignals(goodBrand, 'https://mothandmoon.com');
  assert.equal(s.platform, 'shopify');
  assert.equal(s.has_viewport, true);
  assert.equal(s.is_ecommerce, true);
  assert.ok(s.collection_links >= 4);
  assert.ok(s.paid_apps.includes('klaviyo'));
  assert.equal(s.has_press, true);
  assert.equal(s.has_wholesale, true);
  assert.equal(s.has_team, true);
  assert.equal(s.has_email_capture, true);
  assert.equal(s.copyright_year, 2026);
  assert.equal(s.us_hint, true);
  assert.ok(s.emails.includes('sasha@mothandmoon.com'));
  assert.equal(s.socials.instagram, 'https://instagram.com/mothandmoon');
  assert.ok(s.price_max >= 180);
});

test('extractSignals detects the broken-site problems', () => {
  const s = extractSignals(brokenBrand, 'https://ashstudio.com');
  assert.equal(s.has_viewport, false);
  assert.equal(s.img_lazy, 0);
  assert.equal(s.img_srcset, 0);
  assert.equal(s.copyright_year, 2019);
  assert.equal(s.manual_order_hint, true);
});

test('guessNiche classifies from page text', () => {
  assert.equal(guessNiche(extractSignals(goodBrand, 'https://x.com'), NICHES, DEFAULT_NICHE), 'craft_goods');
});

test('hardFilter rejects parked, empty and corporate pages', () => {
  const empty = extractSignals('<html><body><p>hi</p></body></html>', 'https://x.com');
  assert.equal(hardFilter(empty, {}).pass, false);

  const parked = extractSignals(
    `<html><body><p>${'This domain is for sale. Buy this domain today. '.repeat(20)}</p></body></html>`,
    'https://x.com'
  );
  assert.equal(hardFilter(parked, {}).pass, false);

  const corp = extractSignals(
    `<html><body><p>${'Investor relations and our global footprint. '.repeat(20)}</p></body></html>`,
    'https://x.com'
  );
  assert.equal(hardFilter(corp, {}).pass, false);

  assert.equal(hardFilter(extractSignals(goodBrand, 'https://x.com'), { domain: 'mothandmoon.com' }).pass, true);
});

test('a healthy brand scores high on money, low on website need', () => {
  const s = extractSignals(goodBrand, 'https://mothandmoon.com');
  const d = deterministicScore(s, { domain: 'mothandmoon.com' });
  assert.ok(d.dimensions.money >= 70, `money was ${d.dimensions.money}`);
  assert.ok(d.website_need <= 10, `website_need was ${d.website_need}`);
  assert.equal(d.dimensions.contactability, 95);   // named human, not info@
  assert.ok(d.power_signals.includes('premium_pricing'));
  assert.ok(d.power_signals.includes('stockists_or_wholesale'));
});

test('a good site with manual ordering still registers a system opportunity', () => {
  // This is the case the whole "two opportunity engines" rule exists for.
  const s = extractSignals(goodBrand.replace('Add to cart', 'DM us to order'), 'https://x.com');
  const d = deterministicScore(s, { domain: 'x.com' });
  assert.ok(d.system_need > 0, 'should see a system opportunity');
  assert.ok(d.system_opportunities.some((t) => /manually|DM/i.test(t)));
});

test('a broken site scores high website need', () => {
  const s = extractSignals(brokenBrand, 'https://ashstudio.com');
  const d = deterministicScore(s, { domain: 'ashstudio.com' });
  assert.ok(d.website_need >= 50, `website_need was ${d.website_need}`);
  assert.ok(d.website_problems.some((p) => /viewport/i.test(p)));
  assert.ok(d.website_problems.some((p) => /copyright/i.test(p)));
});

test('need uses the better of website and system, never website alone', () => {
  const s = extractSignals(goodBrand.replace('Add to cart', 'DM us to order'), 'https://x.com');
  const d = deterministicScore(s, { domain: 'x.com' });
  assert.equal(d.dimensions.need, Math.max(d.website_need, d.system_need));
});

test('a bad website with no money signals does not score well', () => {
  // The failure mode the megaprompt calls out: bad site != good lead.
  const poor = extractSignals(
    `<html><body><p>${'my art page. '.repeat(60)}</p><footer>© 2018</footer></body></html>`,
    'https://x.com'
  );
  const d = deterministicScore(poor, { domain: 'x.com' });
  const f = finalScore(d, null);
  assert.ok(f.score < 55, `scored ${f.score}, should be low without money signals`);
});

test('finalScore lets AI raise need but never lower measured problems', () => {
  const s = extractSignals(brokenBrand, 'https://ashstudio.com');
  const d = deterministicScore(s, { domain: 'ashstudio.com' });
  const lowered = finalScore(d, { need_score: 5, would_lucia_want: true });
  assert.equal(lowered.dimensions.need, d.dimensions.need, 'AI must not lower measured need');

  const raised = finalScore(d, { need_score: 99, would_lucia_want: true });
  assert.equal(raised.dimensions.need, 99);
});

test('AI veto caps the score regardless of other dimensions', () => {
  const s = extractSignals(goodBrand, 'https://mothandmoon.com');
  const d = deterministicScore(s, { domain: 'mothandmoon.com' });
  const vetoed = finalScore(d, {
    fit_score: 95, creative_score: 95, conversion_score: 95,
    would_lucia_want: false, veto_reason: 'dropshipper',
  });
  assert.ok(vetoed.score <= 35);
  assert.equal(vetoed.vetoed, true);
  assert.match(vetoed.reason, /dropshipper/);
});

test('selectPeerLinks follows brand links and skips infrastructure', () => {
  const html = `<html><body>
    <a href="https://cdn.shopify.com/x.js">cdn</a>
    <a href="https://fonts.googleapis.com/x">fonts</a>
    <a href="https://stripe.com">payments</a>
    <a href="https://instagram.com/me">instagram</a>
    <a href="https://peerbrand.com">Stockists</a>
    <a href="https://friendbrand.com">brands we love</a>
    <a href="https://deep.example.com/a/b/c/d">deep page</a>
    <a href="/about">About</a>
  </body></html>`;
  const s = extractSignals(html, 'https://source.com');
  const peers = selectPeerLinks(s, 'https://source.com', 0);
  const domains = peers.map((p) => p.url.replace('https://', ''));

  assert.ok(domains.includes('peerbrand.com'));
  assert.ok(domains.includes('friendbrand.com'));
  assert.ok(!domains.includes('cdn.shopify.com'));
  assert.ok(!domains.includes('fonts.googleapis.com'));
  assert.ok(!domains.includes('stripe.com'));
  assert.ok(!domains.includes('instagram.com'));
  assert.ok(!domains.some((d) => d.startsWith('source.com')));
  // Anchor text matching a peer hint should outrank a bare deep link.
  assert.ok(peers[0].priority >= 40);
});

test('non-US storefronts are rejected on positive evidence only', async () => {
  const { detectNonUS } = await import('../src/score.js');
  const uk = extractSignals(
    `<html><body><p>${'Handmade in our London studio. '.repeat(20)} Price £45.00. Shipping across England.</p></body></html>`,
    'https://x.com'
  );
  assert.ok(detectNonUS(uk), 'should detect a UK shop');
  assert.equal(hardFilter(uk, {}).pass, false);

  // A US brand that never states its location must NOT be rejected.
  const quiet = extractSignals(
    `<html><body><p>${'Small batch candles poured in our studio. '.repeat(20)} $38.00</p></body></html>`,
    'https://x.com'
  );
  assert.equal(detectNonUS(quiet), null);
  assert.equal(hardFilter(quiet, {}).pass, true, 'absence of a US signal is not evidence of absence');
});

test('vague compliments from production are rejected before sending', async () => {
  const { isSpecificCompliment } = await import('../src/outreach.js');
  // Verbatim from the first production run - all three were sent as drafts.
  for (const bad of [
    'aesthetic personality and unique products',
    'unique brand personality and values',
    'brand personality and handmade products',
    'strong brand identity',
  ]) {
    assert.equal(isSpecificCompliment(bad), false, `should reject "${bad}"`);
  }
  for (const good of [
    'the ash-glazed vase collection',
    'the way you photograph every piece against raw linen',
    'that you name each mug after a customer',
  ]) {
    assert.equal(isSpecificCompliment(good), true, `should keep "${good}"`);
  }
});

test('internal field labels never reach sent copy', async () => {
  const { composeDraft } = await import('../src/outreach.js');
  const draft = composeDraft({
    niche: 'craft_goods',
    display_name: 'Moth & Moon',
    domain: 'mothandmoon.com',
    system_opportunity: 'system opportunity: booking flow for workshops',
    personalization: JSON.stringify({ liked: 'the ash-glazed vase collection' }),
  }, { SENDER_EMAIL: 'x@y.com', SENDER_POSTAL_ADDRESS: '1 Test St' });

  assert.ok(draft, 'a specific compliment should produce a draft');
  assert.ok(!/system opportunity:/i.test(draft.body), 'field label leaked into the email');
  assert.match(draft.body, /booking flow for workshops/);
});
