// Scoring, in three stages.
//
//   hardFilter()          reject outright, costs nothing
//   deterministicScore()  rules only — decides who is worth an AI call
//   finalScore()          folds the AI's judgement into the rule-based score
//
// The ordering is the whole cost-control strategy: only candidates that clear
// a deterministic bar ever reach the model.

import { WEIGHTS, POWER_SIGNALS, CORPORATE_MARKERS, MARKETPLACE_HOSTS } from './config.js';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * Cheap disqualifiers. Returns { pass, reason }.
 * Deliberately conservative — a false reject is permanent, so we only reject
 * on things we are certain about.
 */
export function hardFilter(signals, entity) {
  if (!signals) return { pass: false, reason: 'no-signals' };

  const hay = `${signals.title} ${signals.text_sample}`.toLowerCase();

  for (const marker of CORPORATE_MARKERS) {
    if (hay.includes(marker)) return { pass: false, reason: `corporate:${marker}` };
  }

  if (entity?.domain && MARKETPLACE_HOSTS.has(entity.domain)) {
    return { pass: false, reason: 'marketplace-only' };
  }

  // Parked domain, holding page, or a fetch that returned a shell.
  if ((signals.word_count || 0) < 40 && (signals.img_count || 0) < 3) {
    return { pass: false, reason: 'empty-page' };
  }

  if (/domain (?:is )?for sale|buy this domain|parked (?:free )?courtesy/i.test(hay)) {
    return { pass: false, reason: 'parked-domain' };
  }

  if (/coming soon|under construction|opening soon/i.test(hay) && (signals.word_count || 0) < 150) {
    return { pass: false, reason: 'placeholder-site' };
  }

  // Geography is a hard constraint (US only), but absence of a US signal is
  // not evidence of absence — plenty of small US brands never state where
  // they are. So reject only on POSITIVE evidence of somewhere else.
  const foreign = detectNonUS(signals);
  if (foreign && !signals.us_hint) return { pass: false, reason: `non-us:${foreign}` };

  return { pass: true, reason: null };
}

// Currency and address markers that only appear on a non-US storefront.
const FOREIGN_CURRENCY = /(?:£\s?\d|€\s?\d|₹\s?\d|¥\s?\d|\bAED\b|\bSAR\b|\bINR\b|\bGBP\b|\bEUR\b|\bCAD\b|\bAUD\b)/;
const FOREIGN_ADDRESS = /\b(?:united kingdom|england|scotland|ireland|deutschland|germany|france|españa|spain|italia|nederland|australia|new zealand|canada|ontario|québec|quebec|british columbia|saudi arabia|united arab emirates|dubai|abu dhabi|mumbai|delhi|bangalore|singapore|malaysia|philippines|jakarta|bangkok|shanghai|shenzhen|tokyo|seoul)\b/i;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/;

export function detectNonUS(signals) {
  const text = signals.text_sample || '';
  if (FOREIGN_CURRENCY.test(text)) return 'currency';
  if (FOREIGN_ADDRESS.test(text)) return 'address';
  if (UK_POSTCODE.test(text)) return 'uk-postcode';
  return null;
}

/**
 * Rule-based scoring. Produces both the dimension estimates and the list of
 * concrete signals behind them, so every score can be explained.
 */
export function deterministicScore(signals, entity) {
  const power = [];
  const problems = [];
  const systems = [];

  // --- MONEY: purchasing-power proxies. Never invents revenue. -----------
  let money = 0;
  const add = (name) => { if (POWER_SIGNALS[name]) { money += POWER_SIGNALS[name]; power.push(name); } };

  if (entity?.domain && !MARKETPLACE_HOSTS.has(entity.domain)) add('custom_domain');
  if (signals.platform && ['shopify', 'bigcommerce', 'squarespace'].includes(signals.platform)) add('ecommerce_platform');
  if (signals.product_links >= 8 || signals.add_to_cart_hits >= 8) add('many_products');
  if (signals.price_median != null && signals.price_median >= 60) add('premium_pricing');
  if (signals.price_max != null && signals.price_max >= 250) add('premium_pricing');
  if (signals.img_srcset >= 6 || (signals.img_count >= 15 && signals.img_lazy >= 5)) add('professional_photography');
  if (signals.has_press) add('press_or_features');
  if (signals.has_wholesale) add('stockists_or_wholesale');
  if (signals.has_team) add('team_page');
  if (signals.has_blog) add('active_blog_or_journal');
  if (signals.has_email_capture) add('email_capture');
  if (signals.paid_apps?.length) add('paid_apps_installed');
  if (signals.collection_links >= 4) add('multiple_collections');
  if (signals.has_events) add('events_or_popups');
  money = clamp(money);

  // --- NEED (website): concrete, evidence-backed problems only ----------
  let need = 0;
  const year = new Date().getUTCFullYear();

  if (!signals.has_viewport) { need += 30; problems.push('no mobile viewport meta — the site is not built responsively'); }
  if (signals.copyright_year && year - signals.copyright_year >= 3) {
    need += 18; problems.push(`copyright still reads ${signals.copyright_year}`);
  }
  if (['carrd', 'linktree'].includes(signals.platform)) {
    need += 28; problems.push('entire web presence is a single-page link site');
  }
  if (signals.platform === 'wix' || signals.platform === 'bigcartel') {
    need += 12; problems.push(`${signals.platform} template with limited design control`);
  }
  if (signals.img_count >= 12 && signals.img_lazy === 0 && signals.img_srcset === 0) {
    need += 16; problems.push(`${signals.img_count} images with no lazy-loading or srcset — slow on mobile`);
  }
  if (signals.img_count >= 6 && signals.img_with_dims === 0) {
    need += 8; problems.push('images have no width/height — layout shifts while loading');
  }
  if (signals.word_count < 180 && signals.img_count > 6) {
    need += 10; problems.push('almost no copy — the brand story is not told anywhere');
  }
  if (!signals.meta_description) { need += 6; problems.push('no meta description'); }
  need = clamp(need);

  // --- SYSTEM opportunity: evaluated separately, on purpose -------------
  let system = 0;
  if (signals.manual_order_hint) {
    system += 35; systems.push('orders taken manually by DM or email — no checkout flow');
  }
  if (signals.has_booking === false && /studio|session|consult|workshop|class|appointment|commission/i.test(signals.text_sample || '')) {
    system += 25; systems.push('sells sessions or commissions with no booking flow on the site');
  }
  if (signals.has_wholesale && !signals.has_cart) {
    system += 20; systems.push('wholesale/stockist programme with no ordering portal');
  }
  if (signals.is_ecommerce && !signals.has_email_capture) {
    system += 12; systems.push('selling online with no email capture');
  }
  if (signals.has_events) {
    system += 10; systems.push('runs events/pop-ups — scheduling and RSVP could be systematised');
  }
  if (signals.product_links >= 20 && !signals.paid_apps?.length) {
    system += 10; systems.push('large catalogue with no reviews/retention tooling');
  }
  system = clamp(system);

  // --- CONTACTABILITY ---------------------------------------------------
  let contact = 0;
  const emails = signals.emails || [];
  const personal = emails.find((e) => !/^(info|hello|contact|support|sales|admin|orders|help)@/i.test(e));
  if (personal) contact = 95;
  else if (emails.length) contact = 70;
  else if (signals.socials?.instagram) contact = 35;
  else contact = 10;

  // --- PERSONALIZATION: do we have enough real material to be specific? --
  let personalization = 0;
  if (signals.word_count >= 250) personalization += 30;
  if (signals.has_blog) personalization += 15;
  if (signals.title) personalization += 10;
  if (signals.meta_description) personalization += 10;
  if (signals.collection_links >= 2) personalization += 15;
  if (signals.has_press) personalization += 10;
  if (signals.socials?.instagram) personalization += 10;
  personalization = clamp(personalization);

  // --- FIT: rules can only estimate. The AI does the real work here. -----
  let fit = 40;
  if (signals.us_hint) fit += 20;
  if (signals.is_ecommerce) fit += 10;
  if (signals.has_team) fit += 5;
  if (signals.word_count >= 300) fit += 10;
  fit = clamp(fit);

  // Need for scoring purposes is the better of the two opportunity types —
  // never the website alone. A good site with a real system gap still counts.
  const needCombined = clamp(Math.max(need, system));

  const dimensions = {
    fit,
    money,
    need: needCombined,
    creative: 50,          // placeholder until the AI looks
    contactability: contact,
    personalization,
    conversion: 50,        // placeholder until the AI looks
  };

  return {
    prescore: weighted(dimensions),
    dimensions,
    power_signals: power,
    website_problems: problems,
    system_opportunities: systems,
    website_need: need,
    system_need: system,
  };
}

function weighted(d) {
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) total += (d[k] ?? 50) * (w / 100);
  return Math.round(total);
}

/**
 * Fold the AI's judgement in. The model can move fit, creative, need and
 * conversion; it cannot touch money or contactability, which stay evidence-based.
 */
export function finalScore(det, ai) {
  const d = { ...det.dimensions };

  if (ai) {
    if (Number.isFinite(ai.fit_score)) d.fit = clamp(ai.fit_score);
    if (Number.isFinite(ai.creative_score)) d.creative = clamp(ai.creative_score);
    if (Number.isFinite(ai.conversion_score)) d.conversion = clamp(ai.conversion_score);

    // The model may raise need if it sees an opportunity the rules missed,
    // but it may not lower evidence-backed problems below what we measured.
    if (Number.isFinite(ai.need_score)) d.need = clamp(Math.max(d.need, ai.need_score));

    // Hard veto: if the sender would not want the work, nothing else matters.
    if ((ai.worth_contacting ?? ai.would_lucia_want) === false) {
      return {
        score: Math.min(weighted(d), 35),
        dimensions: d,
        reason: `AI veto: ${ai.veto_reason || 'not a fit for this profile'}`,
        vetoed: true,
      };
    }
  }

  const score = weighted(d);
  const top = Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k} ${v}`).join(', ');

  return {
    score,
    dimensions: d,
    reason: ai?.summary ? `${ai.summary} (${top})` : `Strongest: ${top}`,
    vetoed: false,
  };
}


/**
 * Scoring for a business with no website.
 *
 * There is no page to audit, so every signal comes from OSM tags and the
 * social handle. That sounds weaker, and for `money` it is — but for `need`
 * it is the opposite. A shop with a real Instagram following and nowhere to
 * send people has the largest website opportunity there is, and usually knows
 * it. A scoring brief will often call this out: businesses that need a real site
 * site rather than a link-in-bio page.
 *
 * The deliberate asymmetry: need is high by construction, so money and
 * legitimacy have to be earned from evidence, or these would all score well
 * on nothing.
 */
export function scoreWithoutWebsite(entity, osmTags = {}) {
  const t = osmTags || {};
  const power = [];
  const problems = [];
  const systems = [];

  // --- NEED: they have no site. That is the whole opportunity. ----------
  let need = 82;
  problems.push('no website at all — the business exists only on Instagram and in person');
  if (entity.instagram) {
    need += 8;
    problems.push('an audience on Instagram with nowhere to send it');
  }
  need = clamp(need);

  // --- MONEY: a physical premises is itself a real signal (rent). -------
  let money = 0;
  const add = (name, pts) => { money += pts; power.push(name); };

  if (t['addr:street']) add('physical_location', 18);
  if (t.opening_hours) add('regular_trading_hours', 14);
  if (t.phone || entity.phone) add('published_phone_line', 10);
  if (t['payment:credit_cards']) add('card_payments', 8);
  if (t.description) add('describes_itself', 6);
  if (t.wheelchair) add('fitted_out_premises', 6);
  if (entity.instagram) add('active_social_presence', 12);
  if (t.brand) add('established_identity', 6);
  money = clamp(money);

  // --- SYSTEM: no site means no booking, no catalogue, no orders. -------
  let system = 30;
  systems.push('no online ordering, booking or catalogue of any kind');
  if (['artist_portfolio', 'creative_studio'].includes(entity.niche)) {
    system += 15;
    systems.push('commissions and enquiries handled entirely by phone or DM');
  }
  system = clamp(system);

  // --- CONTACTABILITY: no site means no email. This is the weak spot. ---
  let contact = 0;
  if (entity.contact_email) contact = 80;
  else if (entity.instagram && (t.phone || entity.phone)) contact = 45;
  else if (entity.instagram) contact = 35;
  else if (t.phone || entity.phone) contact = 25;

  // --- PERSONALIZATION: thin, and honestly so. --------------------------
  let personalization = 0;
  if (entity.display_name) personalization += 15;
  if (t.description) personalization += 25;
  if (entity.instagram) personalization += 20;
  if (t.shop || t.craft) personalization += 15;
  personalization = clamp(personalization);

  let fit = 45;
  if (t['addr:state']) fit += 20;          // confirmed US premises
  if (t.craft) fit += 15;                  // an actual maker
  if (entity.instagram) fit += 10;
  fit = clamp(fit);

  const dimensions = {
    fit,
    money,
    need: clamp(Math.max(need, system)),
    creative: 50,
    contactability: contact,
    personalization,
    conversion: 50,
  };

  return {
    prescore: weighted(dimensions),
    dimensions,
    power_signals: power,
    website_problems: problems,
    system_opportunities: systems,
    website_need: need,
    system_need: system,
    no_website: true,
  };
}
