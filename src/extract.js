// Deterministic signal extraction from raw HTML.
//
// Everything here is rules, no AI. That is the point: this is the cheap layer
// that decides which small fraction of businesses are worth spending an LLM
// call on. Roughly 90% of what we need to know is mechanically extractable.
//
// Regex over a byte-capped string rather than HTMLRewriter, chosen for one
// reason: it runs and is testable outside the Workers runtime, so the scoring
// logic can be unit-tested with `node --test`. At a 900KB cap the cost is a
// few milliseconds per page.

const strip = (s) =>
  String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

const textOf = (html) =>
  strip(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : null;
};

const PLATFORMS = [
  ['shopify', /cdn\.shopify\.com|shopify\.com\/s\/files|Shopify\.theme|myshopify\.com/i],
  ['squarespace', /squarespace\.com|static1\.squarespace|Squarespace\.afterBodyLoad/i],
  ['wix', /wix\.com|wixstatic\.com|parastorage\.com/i],
  ['webflow', /webflow\.com|website-files\.com|wf-domain/i],
  ['wordpress', /wp-content|wp-includes|wordpress/i],
  ['bigcartel', /bigcartel\.com/i],
  ['bigcommerce', /bigcommerce\.com/i],
  ['cargo', /cargo\.site|cargocollective/i],
  ['format', /format\.com/i],
  ['carrd', /carrd\.co/i],
];

// Third-party apps that cost real money. Their presence is a purchasing-power
// signal: someone is already spending on this business.
const PAID_APPS = [
  ['klaviyo', /klaviyo/i],
  ['yotpo', /yotpo/i],
  ['judgeme', /judge\.me/i],
  ['gorgias', /gorgias/i],
  ['recharge', /rechargepayments|recharge-cdn/i],
  ['loox', /loox\.io/i],
  ['okendo', /okendo/i],
  ['attentive', /attentivemobile/i],
  ['postscript', /postscript\.io/i],
  ['rebuy', /rebuyengine/i],
];

const BOOKING = /calendly|acuityscheduling|squareup\.com\/appointments|book\s+(?:a|an|now|online)|schedule\s+(?:a|an)\s+(?:call|session|consult)|appointment|reserve\s+your/i;
const WHOLESALE = /wholesale|stockist|stockists|retailers|where\s+to\s+buy|trade\s+account|faire\.com/i;
const PRESS = /as\s+seen\s+in|press|featured\s+in|in\s+the\s+news|vogue|nylon|dazed|hypebeast|refinery29|the\s+cut|paper\s+magazine/i;
const TEAM = /our\s+team|meet\s+the\s+team|about\s+us|founded\s+by|our\s+story|studio\s+team/i;
const EVENTS = /pop-?up|market\s+dates|craft\s+fair|trunk\s+show|our\s+events|upcoming\s+shows/i;
const EMAIL_CAPTURE = /newsletter|subscribe|join\s+the\s+list|sign\s+up\s+for|mailing\s+list/i;
const BLOG = /\/blog|\/journal|\/news|\/stories|\/diary/i;
const MANUAL_ORDER = /dm\s+(?:me|us)\s+to\s+order|email\s+(?:me|us)\s+to\s+order|message\s+(?:me|us)\s+for|order\s+via\s+(?:dm|instagram)|custom\s+order\s+form|inquire\s+for\s+pricing|contact\s+for\s+pricing/i;

const US_STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b[\s,]*\d{5}/;
const US_WORDS = /\b(united states|usa|u\.s\.a|brooklyn|los angeles|new york|portland|austin|chicago|seattle|nashville|philadelphia|oakland|atlanta|denver|minneapolis|richmond|providence)\b/i;

/**
 * Pull every signal we can get mechanically.
 * @returns {object} signals, plus `text_sample` and `links`
 */
export function extractSignals(html, pageUrl) {
  const clean = strip(html);
  const text = textOf(html);
  const lower = clean.toLowerCase();

  const title = (clean.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] || '').trim();
  const metaDesc =
    clean.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i)?.[0] || '';
  const ogSite = clean.match(/<meta[^>]+property\s*=\s*["']og:site_name["'][^>]*>/i)?.[0] || '';
  const generator = clean.match(/<meta[^>]+name\s*=\s*["']generator["'][^>]*>/i)?.[0] || '';

  // --- platform ---------------------------------------------------------
  let platform = null;
  for (const [name, rx] of PLATFORMS) {
    if (rx.test(html)) { platform = name; break; }
  }
  if (!platform && /generator/i.test(generator)) {
    platform = (attr(generator, 'content') || '').split(/[\s\d]/)[0].toLowerCase() || null;
  }

  // --- links ------------------------------------------------------------
  const links = [];
  const socials = { instagram: null, tiktok: null, etsy: null, facebook: null, pinterest: null, youtube: null };
  const anchorRx = /<a\b([^>]*)>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = anchorRx.exec(clean)) !== null) {
    const href = attr(m[1], 'href');
    if (!href) continue;
    const label = textOf(m[2]).slice(0, 120);
    let abs;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;

    const host = (() => { try { return new URL(abs).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    if (host.endsWith('instagram.com') && !socials.instagram) socials.instagram = abs;
    else if (host.endsWith('tiktok.com') && !socials.tiktok) socials.tiktok = abs;
    else if (host.endsWith('etsy.com') && !socials.etsy) socials.etsy = abs;
    else if (host.endsWith('facebook.com') && !socials.facebook) socials.facebook = abs;
    else if (host.endsWith('pinterest.com') && !socials.pinterest) socials.pinterest = abs;
    else if (host.endsWith('youtube.com') && !socials.youtube) socials.youtube = abs;

    links.push({ url: abs, label, host });
    if (links.length > 400) break;
  }

  // --- prices -----------------------------------------------------------
  const prices = [];
  const priceRx = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  let pm;
  while ((pm = priceRx.exec(text)) !== null) {
    const v = Number(pm[1].replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0 && v < 100_000) prices.push(v);
    if (prices.length > 300) break;
  }
  prices.sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const maxPrice = prices.length ? prices[prices.length - 1] : null;

  // --- images -----------------------------------------------------------
  const imgTags = clean.match(/<img\b[^>]*>/gi) || [];
  const imgCount = imgTags.length;
  const imgsWithDims = imgTags.filter((t) => /width\s*=/i.test(t) && /height\s*=/i.test(t)).length;
  const lazyImgs = imgTags.filter((t) => /loading\s*=\s*["']lazy["']/i.test(t)).length;
  const srcsetImgs = imgTags.filter((t) => /srcset\s*=/i.test(t)).length;

  // --- product / commerce ----------------------------------------------
  const addToCart = (lower.match(/add to cart|add to bag|buy now|shop now/g) || []).length;
  const productLinks = links.filter((l) => /\/products?\//i.test(l.url)).length;
  const collectionLinks = links.filter((l) => /\/collections?\/|\/shop\//i.test(l.url)).length;
  const hasCart = /\/cart|shopping-cart|cart-count|cart-drawer/i.test(clean);

  // --- emails -----------------------------------------------------------
  // Three sources, because plain mailto: links miss most of them.
  const emails = [
    ...new Set([
      ...[...clean.matchAll(/mailto:([^"'?\s>]+)/gi)].map((x) => decodeURIComponent(x[1]).toLowerCase()),
      ...[...text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g)].map((x) => x[0].toLowerCase()),
      ...decodeCloudflareEmails(html),
      ...decodeObfuscated(text),
    ]),
  ].filter(isUsableEmail);

  // --- copyright year (staleness) ---------------------------------------
  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)]
    .map((x) => Number(x[1]))
    .filter((y) => y >= 2000 && y <= 2100);
  const copyrightYear = years.length ? Math.max(...years) : null;

  // --- paid apps --------------------------------------------------------
  const apps = PAID_APPS.filter(([, rx]) => rx.test(html)).map(([n]) => n);

  const viewport = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(clean);

  return {
    title,
    meta_description: (attr(metaDesc, 'content') || '').slice(0, 400),
    og_site_name: attr(ogSite, 'content'),
    platform,
    has_viewport: viewport,
    responsive_hint: viewport && (srcsetImgs > 0 || /@media/i.test(html)),

    price_count: prices.length,
    price_median: median,
    price_max: maxPrice,

    img_count: imgCount,
    img_with_dims: imgsWithDims,
    img_lazy: lazyImgs,
    img_srcset: srcsetImgs,

    add_to_cart_hits: addToCart,
    product_links: productLinks,
    collection_links: collectionLinks,
    has_cart: hasCart,
    is_ecommerce: hasCart || addToCart > 0 || productLinks > 0,

    has_wholesale: WHOLESALE.test(text),
    has_press: PRESS.test(text),
    has_team: TEAM.test(text),
    has_events: EVENTS.test(text),
    has_booking: BOOKING.test(clean),
    has_email_capture: EMAIL_CAPTURE.test(text),
    has_blog: BLOG.test(clean),
    manual_order_hint: MANUAL_ORDER.test(text),

    paid_apps: apps,
    socials,
    emails: emails.slice(0, 10),
    copyright_year: copyrightYear,

    text_len: text.length,
    word_count: text ? text.split(/\s+/).length : 0,
    us_hint: US_STATES.test(text) || US_WORDS.test(text),

    text_sample: text.slice(0, 3000),
    links,
    contact_links: contactLinks(links, pageUrl),
  };
}

/**
 * Pages likely to carry an email address.
 *
 * Most independent sites keep contact details off the homepage, which is why
 * two thirds of leads were arriving with no way to reach them. One extra
 * fetch of the right page recovers most of those.
 *
 * Ordered by how likely each is to pay off, so the pipeline can try just one.
 */
export function contactLinks(links, pageUrl) {
  let host;
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return []; }

  const scored = [];
  for (const l of links || []) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== host) continue;

    const path = u.pathname.toLowerCase();
    const label = (l.label || '').toLowerCase();
    let score = 0;

    if (/\/contact/.test(path)) score += 50;
    else if (/\/about/.test(path)) score += 30;
    else if (/\/pages\/(?:contact|about|our-story|stockists|wholesale)/.test(path)) score += 40;
    else if (/\/(?:info|support|help|faq|imprint|impressum|legal|team)/.test(path)) score += 20;
    else if (/\/(?:stockists|wholesale|trade|press)/.test(path)) score += 18;

    if (/\bcontact\b|get in touch|say hello|reach us|email us/.test(label)) score += 25;
    else if (/\babout\b|our story|the studio/.test(label)) score += 12;

    if (score > 0) scored.push({ url: u.toString(), score, path });
  }

  const seen = new Set();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((x) => (seen.has(x.path) ? false : seen.add(x.path)))
    .slice(0, 3)
    .map((x) => x.url);
}

/**
 * Guess the niche from page text. Deterministic, so it costs nothing and runs
 * before any AI call. The AI can override it later with better judgement.
 */
export function guessNiche(signals, niches, fallback) {
  const hay = `${signals.title} ${signals.meta_description} ${signals.text_sample}`.toLowerCase();
  let best = null;
  for (const [slug, def] of Object.entries(niches)) {
    let hits = 0;
    for (const kw of def.keywords) {
      if (hay.includes(kw)) hits += kw.includes(' ') ? 2 : 1;   // phrases count double
    }
    if (hits && (!best || hits > best.hits)) best = { slug, hits };
  }
  return best && best.hits >= 2 ? best.slug : fallback;
}


/**
 * Decode Cloudflare's email obfuscation.
 *
 * Any Cloudflare-proxied site with Email Address Obfuscation on replaces
 * addresses with a hex blob, so a plain mailto: scan finds nothing. Since a
 * large share of independent brand sites sit behind Cloudflare, this recovers
 * contact details that would otherwise be invisible.
 *
 * Format: first byte is an XOR key, the rest is the address.
 */
export function decodeCloudflareEmails(html) {
  const out = [];
  const rx = /(?:data-cfemail=["']|\/cdn-cgi\/l\/email-protection#)([0-9a-f]{8,})/gi;
  let m;
  while ((m = rx.exec(String(html || ''))) !== null) {
    const hex = m[1];
    try {
      const key = parseInt(hex.slice(0, 2), 16);
      let email = '';
      for (let i = 2; i < hex.length; i += 2) {
        email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      }
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.push(email.toLowerCase());
    } catch { /* skip malformed blob */ }
    if (out.length > 10) break;
  }
  return out;
}

/**
 * Decode addresses written to defeat scrapers: "hello (at) brand (dot) com".
 *
 * Small studios do this constantly, and it is a deliberate, published way of
 * saying "here is how to reach me" — so reading it is reading their contact
 * details, not circumventing anything.
 */
export function decodeObfuscated(text) {
  const out = [];
  const rx = /\b([\w.+-]{2,40})\s*(?:\(|\[|\{)?\s*(?:at|@)\s*(?:\)|\]|\})?\s*([\w-]{2,40})\s*(?:\(|\[|\{)?\s*(?:dot|\.)\s*(?:\)|\]|\})?\s*([a-z]{2,12})\b/gi;
  let m;
  while ((m = rx.exec(String(text || ''))) !== null) {
    const candidate = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,12}$/.test(candidate)) out.push(candidate);
    if (out.length > 6) break;
  }
  return out;
}

// Addresses that are never a real human contact.
const JUNK_EMAIL =
  /\.(png|jpe?g|gif|svg|webp|css|js)$|(?:sentry|wixpress|example|yourdomain|domain|email|placeholder|test)\.|^(?:no-?reply|donotreply|postmaster|abuse|webmaster|hostmaster)@|@(?:sentry|example|test|localhost)/i;

export function isUsableEmail(e) {
  if (!e || e.length > 100) return false;
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return false;
  return !JUNK_EMAIL.test(e);
}
