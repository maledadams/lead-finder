// Tunables in one place. Anything you are likely to argue with lives here.

// ---------------------------------------------------------------------------
// Workers AI model.
//
// VERIFY BEFORE TRUSTING: model availability, per-model Neuron cost and the
// daily Neuron allocation included with Workers Paid all change. Check the
// Cloudflare dashboard against your own account rather than taking this
// constant — or the NEURONS_PER_EVAL estimate — as fact.
// ---------------------------------------------------------------------------
export const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// MEASURED, not guessed. Cloudflare's GraphQL analytics reported 3,969
// neurons across 56 real evaluations of this exact prompt against this exact
// model — about 71 each. The original estimate here was 2,200, which was 31x
// too high and made the AI budget look far more expensive than it is.
//
// Workers Paid includes 10,000 neurons/day, so roughly 140 evaluations a day
// fit inside the included allocation. Re-measure with the GraphQL
// aiInferenceAdaptiveGroups query if the prompt or model changes.
export const NEURONS_PER_EVAL = 75;

// ---------------------------------------------------------------------------
// Niche taxonomy.
//
// Seven buckets, not fifty. Each maps 1:1 to an outreach persona, so
// classification and voice are the same decision.
// ---------------------------------------------------------------------------
export const NICHES = {
  alt_fashion: {
    label: 'Alternative fashion',
    // Classification vocabulary — matched against page text to decide which
    // outreach persona writes the email. Broad on purpose: unlike the
    // discovery keywords, a term costs nothing here if it rarely matches.
    keywords: [
      // alternative / dark
      'emo', 'goth', 'gothic', 'nu goth', 'pastel goth', 'punk', 'grunge',
      'metalcore', 'scene', 'alt fashion', 'alternative clothing',
      'alternative fashion', 'subculture', 'occult', 'witchy',
      // cute
      'cutecore', 'cute', 'kawaii', 'pastel', 'coquette', 'fairycore',
      'dollette', 'babycore', 'sanrio', 'plushie', 'bows', 'ribbon',
      // Japanese-inspired
      'harajuku', 'lolita', 'gothic lolita', 'sweet lolita', 'classic lolita',
      'jirai kei', 'visual kei', 'fairy kei', 'mori kei', 'dolly kei',
      'yami kawaii', 'menhera', 'gyaru', 'decora', 'shironuri', 'jfashion',
      'japanese street', 'japanese inspired', 'tokyo', 'kimono', 'yukata',
      // eras / other
      'y2k', '90s', 'vintage', 'thrifted', 'deadstock', 'upcycled',
      'reworked', 'streetwear', 'corset', 'platform boots', 'handmade clothing',
    ],
  },
  craft_goods: {
    label: 'Handmade & craft goods',
    keywords: [
      'handmade', 'ceramic', 'ceramics', 'pottery', 'jewelry', 'jewellery',
      'stationery', 'enamel pin', 'sticker', 'zine', 'print shop',
      'art object', 'woodwork', 'textile', 'weaving', 'candle', 'artisan',
    ],
  },
  beauty_wellness: {
    label: 'Beauty & skincare',
    keywords: [
      'skincare', 'skin care', 'serum', 'cleanser', 'moisturizer', 'beauty',
      'cosmetics', 'fragrance', 'perfume', 'balm', 'apothecary', 'wellness',
    ],
  },
  food_bev: {
    label: 'Food & beverage',
    keywords: [
      'coffee', 'roaster', 'tea', 'chocolate', 'bakery', 'hot sauce',
      'condiment', 'snack', 'granola', 'kombucha', 'brewery', 'distillery',
      'small batch', 'provisions', 'pantry',
    ],
  },
  artist_portfolio: {
    label: 'Artist / creator portfolio',
    keywords: [
      'illustrator', 'illustration', 'painter', 'fine art', 'photographer',
      'photography', 'portfolio', 'commissions', 'musician', 'band',
      'tattoo artist', 'animator', 'sculptor', 'printmaker',
    ],
  },
  creative_studio: {
    label: 'Creative studio / agency',
    keywords: [
      'design studio', 'creative studio', 'branding agency', 'design agency',
      'creative agency', 'art direction', 'production studio', 'film studio',
      'photo studio', 'we help brands', 'our clients', 'case study',
    ],
  },
  lifestyle_brand: {
    label: 'Creative lifestyle brand',
    keywords: [
      'home goods', 'homeware', 'lifestyle', 'apparel', 'accessories',
      'concept store', 'boutique', 'curated', 'slow living',
    ],
  },
};

export const DEFAULT_NICHE = 'lifestyle_brand';

// ---------------------------------------------------------------------------
// Scoring weights. Must total 100.
//
// Money and creative fit are weighted as heavily as need, on purpose: a
// terrible website belonging to someone who cannot afford the work is still a
// bad lead, and that is the failure mode most lead scorers fall into.
// ---------------------------------------------------------------------------
export const WEIGHTS = {
  fit: 20,
  creative: 20,
  money: 20,
  need: 15,
  contactability: 10,
  personalization: 10,
  conversion: 5,
};

// ---------------------------------------------------------------------------
// Purchasing-power signals. Proxies only — we never invent revenue.
// Each is worth points toward the `money` dimension (capped at 100).
// ---------------------------------------------------------------------------
export const POWER_SIGNALS = {
  custom_domain: 8,
  ecommerce_platform: 14,
  many_products: 14,
  premium_pricing: 16,
  professional_photography: 10,
  press_or_features: 12,
  stockists_or_wholesale: 12,
  physical_location: 8,
  team_page: 10,
  active_blog_or_journal: 6,
  email_capture: 6,
  paid_apps_installed: 8,
  multiple_collections: 8,
  events_or_popups: 6,
};

// Signals that a business is too big / not founder-led. Any hard disqualifier
// rejects outright; soft ones just subtract.
export const CORPORATE_MARKERS = [
  'investor relations', 'careers at', 'nasdaq', 'nyse:', 'our global',
  'fortune 500', 'annual report', 'shareholder', 'board of directors',
  'press@', 'ir@', 'corporate headquarters',
];

// Platforms whose own pages we never treat as a lead's website.
export const MARKETPLACE_HOSTS = new Set([
  'etsy.com', 'www.etsy.com', 'instagram.com', 'www.instagram.com',
  'tiktok.com', 'www.tiktok.com', 'facebook.com', 'www.facebook.com',
  'amazon.com', 'www.amazon.com', 'linktr.ee', 'beacons.ai', 'bio.link',
  'linktree.com', 'twitter.com', 'x.com', 'pinterest.com', 'youtube.com',
  'depop.com', 'ebay.com', 'shop.app', 'bigcartel.com', 'gumroad.com',
]);

// Hosts we never crawl — infrastructure, CDNs, trackers. Keeps the frontier
// clean and avoids wasting fetch budget.
export const CRAWL_SKIP_HOSTS = new Set([
  'google.com', 'gstatic.com', 'googletagmanager.com', 'google-analytics.com',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'cloudflare.com', 'jsdelivr.net',
  'cdnjs.cloudflare.com', 'unpkg.com', 'shopify.com', 'cdn.shopify.com',
  'squarespace.com', 'wix.com', 'wordpress.org', 'w3.org', 'schema.org',
  'apple.com', 'microsoft.com', 'adobe.com', 'stripe.com', 'paypal.com',
  'klaviyo.com', 'mailchimp.com', 'shopifycdn.com', 'wp.com', 'gravatar.com',
]);

// Link text that suggests the destination is a peer brand rather than a
// vendor, legal page, or social profile. This is what makes the link graph
// propagate taste instead of noise.
export const PEER_LINK_HINTS = [
  'stockist', 'stockists', 'retailers', 'where to buy', 'shop the collection',
  'brands we love', 'friends', 'collaborators', 'collaboration', 'collab',
  'featured', 'as seen', 'press', 'partners', 'makers', 'artists we',
  'sister brand', 'our friends', 'shop small', 'directory', 'wholesale',
];

// ---------------------------------------------------------------------------
// Lead states. Discovery and outreach are deliberately separate axes.
// ---------------------------------------------------------------------------
export const STATES = {
  DISCOVERED: 'DISCOVERED',
  EVALUATED: 'EVALUATED',
  QUALIFIED: 'QUALIFIED',
  SHORTLISTED: 'SHORTLISTED',
  OUTREACH_READY: 'OUTREACH_READY',
  CONTACTED: 'CONTACTED',
  REPLIED: 'REPLIED',
  CONVERSATION: 'CONVERSATION',
  CLIENT: 'CLIENT',
  REJECTED: 'REJECTED',
  NURTURE: 'NURTURE',
  NOT_NOW: 'NOT_NOW',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT',
};

// States that must never be surfaced as a new lead again.
export const TERMINAL_STATES = new Set([
  STATES.CONTACTED, STATES.REPLIED, STATES.CONVERSATION,
  STATES.CLIENT, STATES.REJECTED, STATES.DO_NOT_CONTACT,
]);

// States eligible for the daily queue.
export const QUEUEABLE_STATES = new Set([
  STATES.QUALIFIED, STATES.SHORTLISTED, STATES.OUTREACH_READY, STATES.NURTURE,
]);

export function num(env, key, fallback) {
  const v = Number(env?.[key]);
  return Number.isFinite(v) ? v : fallback;
}
