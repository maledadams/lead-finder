// Outreach drafting.
//
// Deliberately NOT a per-lead LLM call. The specifics that make an email feel
// personal — what was admired, what the opportunity is — were already
// extracted during evaluation and are evidence-checked. Composing from those
// costs nothing, keeps the voice consistent, and means 30 drafts add zero AI
// spend. A per-draft polish is available on demand from the dashboard.
//
// If there is no evidence-backed thing to admire, NO DRAFT IS PRODUCED. An
// invented compliment is worse than silence.

/**
 * Per-niche framing.
 *
 * `context` is how the sender describes what they do to THIS kind of business —
 * the credibility line, and the only per-niche text left in an email now that
 * the drafts open on it directly.
 */
const PERSONAS = {
  alt_fashion: {
    label: 'Alternative fashion',
    subject: (n) => `${n} — a few notes on your site`,
    context: 'I design and build websites for independent fashion labels — the kind where the site needs to carry as much personality as the clothes do.',
    offer: 'a short written breakdown of what I would change on the shop pages, with a rough visual of how it could look',
    sign: 'Lucía Adams',
  },
  craft_goods: {
    label: 'Handmade & craft',
    subject: (n) => `${n} — a few notes on your shop pages`,
    context: 'I design and build websites for independent makers and studios, so the site does justice to work that is made by hand.',
    offer: 'a short written breakdown of what I would change, with a rough visual of how the shop could feel closer to the objects themselves',
    sign: 'Lucía Adams',
  },
  beauty_wellness: {
    label: 'Beauty & skincare',
    subject: (n) => `${n} — notes on your product pages`,
    context: 'I design and build websites for independent beauty and skincare brands, where most of the decision happens on the product page.',
    offer: 'a short written breakdown of what I would change on the product pages, and why',
    sign: 'Lucía Adams',
  },
  food_bev: {
    label: 'Food & beverage',
    subject: (n) => `${n} — a thought on your ordering flow`,
    context: 'I design and build websites and ordering systems for small food and drink brands.',
    offer: 'a short teardown of the ordering flow with the specific changes I would make',
    sign: 'Lucía Adams',
  },
  artist_portfolio: {
    label: 'Artist portfolio',
    subject: () => `Your work and where it lives`,
    context: 'I design and build portfolio sites for artists and illustrators — properly built, not a template with your images dropped in.',
    offer: 'a rough layout for what a real portfolio site could look like for your work',
    sign: 'Lucía Adams',
  },
  creative_studio: {
    label: 'Creative studio',
    subject: (n) => `${n} — a note on your own site`,
    context: 'I build websites and internal tools for creative studios — usually the work that gets postponed because client projects come first.',
    offer: 'a short written assessment of your site and the workflow around it, with what I would prioritise',
    sign: 'Lucía Adams',
  },
  lifestyle_brand: {
    label: 'Creative lifestyle brand',
    subject: (n) => `${n} — a few notes on your site`,
    context: 'I design and build websites for independent brands with a clear identity of their own.',
    offer: 'a short written breakdown of what I would change, with a rough visual of where it could go',
    sign: 'Lucía Adams',
  },
};

/**
 * The persona writing this email, from the profile that owns the lead.
 *
 * The built-in set is the creative profile's, kept as the fallback so that
 * profile needs no stored configuration. A configured profile's personas arrive
 * as JSON, which is why `subject` is read as a template as well as a function —
 * JSON cannot hold a function, and a stored profile calling one would throw at
 * the moment a draft is composed.
 */
function personaFor(entity, profile) {
  const set = profile?.personas && Object.keys(profile.personas).length
    ? profile.personas : PERSONAS;
  return set[entity.niche] || set[Object.keys(set)[0]] || PERSONAS.lifestyle_brand;
}

function subjectFor(persona, name) {
  if (typeof persona.subject === 'function') return persona.subject(name);
  return String(persona.subject || '{name} — a few notes on your site')
    .replace(/\{name\}/g, name);
}

/** CTA chosen by which opportunity is actually the strongest. */
function ctaFor(persona, entity, det) {
  const systemLed = det?.system_need > det?.website_need;
  if (systemLed) {
    return 'i had one specific idea for how to take that off your plate — want me to write it up? two minutes to read, no pitch attached';
  }
  return persona.cta;
}


/**
 * The body every draft now shares.
 *
 * Ordered the way a person would actually say it, with the throat-clearing gone
 * and no compliment. Praising a stranger's product to open a cold email is the
 * oldest tell there is, and a reader who has had ten of them reads it as
 * technique rather than as interest. "I came across your shop this week and spent some time on your site"
 * told the reader nothing they did not know and delayed the point by a
 * paragraph, so the email now opens on who is writing and why.
 *
 * Then, in order: what would help, what it is costing them now, and what
 * fixing it involves. Naming the problem alone makes a reader defensive;
 * naming the cost makes it real; naming the work makes it a bounded job rather
 * than an open worry.
 *
 * It promises nothing. No free audit, no document to send, no deadline — an
 * offer creates work whether or not they reply. The close simply says what to
 * do if they want it looked at.
 */
function buildBody({ env, persona, name, greeting, benefit, why, fix, closing }) {
  return [
    greeting,
    '',
    `I'm ${senderName(env)}. ${persona.context}`,
    '',
    BUILD_APPROACH,
    '',
    `${name} could benefit from ${lowerFirst(benefit)}.`,
    why ? '' : null,
    why ? sentence(why) : null,
    fix ? '' : null,
    fix ? `Fixing it means ${lowerFirst(fix)}.` : null,
    '',
    closing,
    signature(env),
    canSpamFooter(env),
  ].filter((l) => l !== undefined && l !== null).join('\n');
}

/** What to do if they want it looked at. Never a promise, never a deadline. */
/**
 * The thing that actually distinguishes the offer, so it belongs in every email
 * of every profile rather than in one persona's copy.
 */
const BUILD_APPROACH = 'Everything I build is written in code rather than assembled on Shopify, Wix or a site builder, so the design is not boxed in by a template and the system can do exactly what the business needs.';

/** Set with `wrangler secret put CAL_BOOKING_URL`. */
export const bookingUrl = (env) => env?.CAL_BOOKING_URL || null;

/**
 * The close. The booking line only appears when a link is configured, so a
 * deployment without one does not send "book a call here:" followed by nothing.
 */
function closing(env) {
  const url = bookingUrl(env);
  return [
    'If any of that is worth doing, reply and I will take a proper look at the site and come back with what I would actually change.',
    url
      ? `Or if you would rather talk it through than read about it, book a 15-minute call here: ${url}`
      : 'Or if you would rather talk it through than read about it, just say and we will find a time.',
    'If it is not a priority right now, no hard feelings. I will not chase.',
  ].join('\n\n');
}

/**
 * Compose a draft. Returns null when there is nothing honest to say.
 *
 * @returns {{subject, body, cta, persona}|null}
 */
export function composeDraft(entity, env, profile = null) {
  const persona = personaFor(entity, profile);
  const p = safeJson(entity.personalization) || {};

  // A business with no website is a different conversation, and it does not
  // need a compliment to be honest — the observation is factual and useful on
  // its own. Requiring one here would silently drop the strongest leads.
  if (p.no_website) return composeNoWebsiteDraft(entity, env, persona);

  // firstClause() also strips internal field labels. It has to be applied to
  // the model's own opportunity_headline as well, not just the stored fields:
  // a live draft went out reading "system opportunity: booking flow for
  // workshops" because p.opportunity bypassed it.
  const opportunity = firstClause(p.opportunity)
    || firstClause(entity.website_opportunity)
    || firstClause(entity.system_opportunity);
  if (!opportunity) return null;

  const name = displayName(entity);
  const greeting = entity.founder_name ? `Hi ${firstName(entity.founder_name)},` : 'Hello,';

  const det = {
    website_need: entity.website_opportunity ? 1 : 0,
    system_need: entity.system_opportunity ? 2 : 0,
  };

  const finding = plainEnglish(opportunity);
  const why = consequenceOf(finding);
  const benefit = benefitOf(opportunity);

  const body = buildBody({
    env, persona, name, greeting,
    liked: p.liked,
    benefit: benefitOf(opportunity),
    why,
    fix: fixFor(opportunity) || GENERIC_FIX,
    closing: closing(env),
  });

  return {
    subject: stripControl(subjectFor(persona, name)).slice(0, 200),
    body,
    cta: persona.offer || null,
    persona: entity.niche || 'lifestyle_brand',
  };
}

/**
 * Draft for a business with no website.
 *
 * Deliberately shorter and plainer than the others. There is no site to have
 * an opinion about, so the email says the one true, useful thing and gets out
 * of the way. No invented praise: we have never seen their work.
 */
function composeNoWebsiteDraft(entity, env, persona) {
  if (!entity.display_name) return null;
  // Without a way to reach them there is nothing to send.
  if (!entity.contact_email) return null;

  const name = entity.display_name;
  const greeting = entity.founder_name ? `Hi ${firstName(entity.founder_name)},` : 'Hello,';
  const hasIg = Boolean(entity.instagram);

  const observation = hasIg
    ? `I came across ${name} on Instagram and went looking for your website — as far as I can tell there isn't one yet.`
    : `I came across ${name} recently and went looking for your website — as far as I can tell there isn't one yet.`;

  const point = hasIg
    ? 'If that is deliberate, ignore me entirely. If it is not, it is worth saying that you have already done the hard part: people find you and like what they see, and then there is nowhere for them to go.'
    : 'If that is deliberate, ignore me entirely.';

  const body = [
    greeting,
    '',
    `I'm ${senderName(env)}. ${persona.context}`,
    '',
    observation,
    '',
    point,
    '',
    `${name} could benefit from a site of its own — somewhere people who already like what you do can actually buy, book or get in touch.`,
    '',
    'That is a small build rather than a big project: a few pages, your own domain, and the things you sell.',
    '',
    closing(env),
    signature(env),
    canSpamFooter(env),
  ].filter((l) => l !== undefined && l !== null).join('\n');

  return {
    subject: stripControl(`${name} — a question about your website`).slice(0, 200),
    body,
    cta: 'offer a free rough visual before any commitment',
    persona: `${entity.niche || 'lifestyle_brand'}:no_website`,
  };
}

/**
 * One signature, never two.
 *
 * The persona's own sign-off is a stylistic fallback for when no sender name
 * is configured. Once SENDER_NAME is set it wins outright, otherwise drafts
 * end with "— lucia" immediately followed by "Lucía Adams".
 */
/**
 * The sign-off that goes above the CAN-SPAM footer.
 *
 * The mail client appends the real one. Two signatures in a single email is
 * the clearest possible tell that the message was machine-assembled, which is
 * exactly the impression this outreach is trying to avoid.
 *
 * The CAN-SPAM footer is separate and still required — a postal address and a
 * working opt-out are legal obligations, not a sign-off.
 */
/** Whoever is actually sending. SENDER_NAME is set in wrangler.toml. */
export function senderName(env) {
  return stripControl(env?.SENDER_NAME) || '[SET SENDER_NAME]';
}

function signature(env) {
  // The Zoho firma is NOT added here. It is fetched from Zoho and appended at
  // send time (see sendMail), because that is the only way the real one — the
  // account's own default — reaches the recipient: Zoho's API does not attach
  // the webmail signature to messages posted through it, which is why sent
  // mail was arriving without it.
  return `\nBest,\n${senderName(env)}`;
}

const sentence = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) + '.' : '');

/**
 * Capitalise the first letter of each sentence.
 *
 * The compliment is lowercased so it can sit mid-sentence, but several
 * templates place it directly after a full stop, which produced lines like
 * "spent some time with it. the ash-glazed vase collection is lovely".
 */
const fixCaps = (t) =>
  String(t || '')
    .replace(/^([a-z])/, (m) => m.toUpperCase())
    .replace(/([.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase());

/**
 * CAN-SPAM requires a real physical postal address and a working opt-out in
 * every commercial message. This is not optional and not decorative.
 */
export function canSpamFooter(env) {
  const addr = env?.SENDER_POSTAL_ADDRESS || '[SET SENDER_POSTAL_ADDRESS]';
  // Softened to sound like a person rather than a compliance line, but it is
  // still a working opt-out and a real postal address, because CAN-SPAM
  // requires both in every commercial email regardless of which mailbox it is
  // sent from. Removing them does not become legal by using a personal
  // address; it just makes the sender personally liable.
  return [
    '',
    'If this is not relevant, just reply and let me know — I will not write again.',
    addr,
  ].join('\n');
}

/**
 * A compliment has to point at something. Generic attribute-speak fails.
 */
const VAGUE_COMPLIMENT = /^(?:the\s+)?(?:aesthetic|brand|unique|strong|beautiful|lovely|great|nice|good|distinct|creative)\b[\w\s]*(?:personality|identity|aesthetic|products?|brand|vibe|feel|style|values?)\s*$/i;

export function isSpecificCompliment(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (t.length < 12 || t.length > 200) return false;
  if (VAGUE_COMPLIMENT.test(t)) return false;
  // "personality and products" - abstractions joined by "and", naming nothing.
  if (/^[\w\s]+ and [\w\s]+$/.test(t) && !/[A-Z0-9"']/.test(t.slice(1))) return false;
  return true;
}

/**
 * Say the finding the way a shop owner would understand it.
 *
 * The audit records things like "no mobile viewport meta" because that is
 * what was measured. Putting that phrase in a cold email to a ceramicist is
 * worse than saying nothing: it reads as jargon, or as a bot. These are the
 * same facts in the language the recipient actually uses.
 */
/**
 * The same findings, said as the thing they would GAIN.
 *
 * PLAIN_ENGLISH describes what is wrong ("there is no way to book you from the
 * site"), which reads correctly after "one thing stood out:" but becomes
 * nonsense after "could benefit from". Naming the business and the upside is
 * warmer and more human, so each finding gets a positive phrasing here. Keyed
 * by the same raw patterns, so the two tables stay in step.
 *
 * Anything unmatched falls back to the observation sentence rather than being
 * forced into a frame it does not fit — a broken sentence is worse than a
 * plainer one.
 */
const BENEFIT = [
  [/no mobile viewport meta.*/i, 'a site that actually works properly on phones'],
  [/entire web presence is a single-page link site/i, 'a proper site of its own rather than a single link page'],
  [/(\d+) images with no lazy-loading or srcset.*/i, 'images that load properly on mobile instead of at full size'],
  [/images have no width\/height.*/i, 'a page that does not jump around while the images load'],
  [/copyright still reads (\d{4})/i, 'a footer that no longer says $1'],
  [/almost no copy.*/i, 'something on the site about who you are'],
  [/no meta description/i, 'a description of its own, so search results say what you want them to'],
  [/(\w+) template with limited design control/i, 'a site that is not boxed in by a $1 template'],
  [/orders taken manually by DM or email.*/i, 'a proper checkout instead of taking orders through DMs'],
  [/sells sessions or commissions with no booking flow.*/i, 'a way for people to book you straight from the site'],
  [/wholesale\/stockist programme with no ordering portal/i, 'an ordering portal, so stockists do not have to email you'],
  [/selling online with no email capture/i, 'a way to keep in touch with people who are not ready to buy yet'],
  [/runs events\/pop-ups.*/i, 'a way to run events and pop-ups without handling each one by hand'],
  [/large catalogue with no reviews\/retention tooling/i, 'something that brings customers back to a catalogue that size'],
];

/**
 * The upside of a finding, or null when there is no honest way to phrase it.
 *
 * Takes the RAW opportunity, not the plain-English version, so it matches the
 * same patterns PLAIN_ENGLISH does.
 */
export function benefitOf(rawFinding) {
  if (!rawFinding) return null;
  const t = String(rawFinding).trim();
  for (const [rx, phrase] of BENEFIT) {
    if (rx.test(t)) return t.replace(rx, phrase);
  }
  // A plainly negative phrase ("no online ordering") carries its own positive.
  const stripped = t.replace(/^(?:there is |they have |the site has )?(?:no|missing|lacks|lacking|without)\s+/i, '');
  if (stripped !== t && stripped.length > 2) return stripped;

  // Last resort: the finding as written. "could benefit from" is now the
  // permanent phrasing, so this must always return something usable. Raw
  // findings are noun-shaped ("a booking flow for workshops"), which reads
  // correctly; a clause-shaped one is nudged into a noun phrase rather than
  // being dropped.
  if (/^(?:there|it|they|this|the site|nothing)\b/i.test(t)) return `some work on ${lowerFirst(t)}`;
  return t;
}

/**
 * How it would actually get fixed, in one clause.
 *
 * The third thing an email has to say. Naming the problem tells someone
 * something is wrong; naming the consequence tells them why it matters; this
 * tells them it is a known, bounded job rather than a vague worry. Keyed by the
 * same raw patterns as PLAIN_ENGLISH and BENEFIT so the three stay in step.
 *
 * Deliberately describes the work, never a promise about doing it.
 */
const FIX = [
  [/no mobile viewport meta.*/i,
    'the layout has to be rebuilt to respond to the screen rather than assume a desktop one. That is real work, not a setting, but it is bounded: the same pages and the same content, laid out so they hold together from a phone up to a monitor. Most of the benefit lands the day it ships, because the majority of your visitors are already on a phone'],
  [/entire web presence is a single-page link site/i,
    'a small proper site is enough. A few pages on your own domain, somewhere to actually buy or enquire, and the link page kept as the thing that points at it. You keep every audience you already have and stop losing the ones who wanted to go further'],
  [/(\d+) images with no lazy-loading or srcset.*/i,
    'the images get served at the size the device actually needs, and anything below the fold waits until it is scrolled to. It is a build change rather than a redesign, so nothing about how the site looks has to change. The page simply starts appearing in about a third of the time on a phone'],
  [/images have no width\/height.*/i,
    'each image gets its dimensions declared so the browser reserves the space before the file arrives. Nothing then jumps as things load. It is a small, contained change and it is the difference between a page that feels considered and one that feels like it is still assembling itself'],
  [/copyright still reads (\d{4})/i,
    'that one is a five-minute change and worth doing today, whoever does it. Worth a wider look at the same time, though, because a footer that has gone stale usually means other things on the site have too'],
  [/almost no copy.*/i,
    'a short page in your own words about how you work and why, and a line or two of context wherever someone is deciding. It does not need to be long and it should not read like marketing. People buying from an independent maker want to know who they are buying from, and right now the site does not tell them'],
  [/no meta description/i,
    'writing the sentence you actually want people to read when you come up in search, for the handful of pages that matter. It takes an afternoon and it is the first thing anyone reads about you, whether or not you chose it'],
  [/(\w+) template with limited design control/i,
    'either a custom theme or a build that is not fighting the template. Keeping the platform is usually fine — the constraint is the theme, not the host — so this is often less disruptive than it sounds, and your product data and orders stay exactly where they are'],
  [/orders taken manually by DM or email.*/i,
    'a real checkout, so an order arrives as an order with the address and the payment already attached. Stock, confirmations and receipts stop being something you do by hand. You keep the conversations you want to have and stop being required to have the ones you do not'],
  [/sells sessions or commissions with no booking flow.*/i,
    'a booking page wired to your real calendar, showing only the times you actually want to offer, taking a deposit if you want one. Someone who is ready can book at eleven at night without waiting for you to reply. You stop losing the people whose enthusiasm does not survive a two-day wait'],
  [/wholesale\/stockist programme with no ordering portal/i,
    'a stockist login with your trade prices and minimums behind it, so a shop can reorder without emailing you and waiting. Wholesale is usually the highest-value channel and the one most likely to repeat, and it is currently the one running entirely through your inbox'],
  [/selling online with no email capture/i,
    'somewhere to leave an address and an actual reason to leave it — early access to a drop, or first sight of new work. Then something sent occasionally enough that people stay subscribed. Most people who visit are not ready to buy that day, and right now every one of them leaves without a trace'],
  [/runs events\/pop-ups.*/i,
    'a page that lists what is coming and takes sign-ups on its own, with the list going somewhere you can actually use afterwards. The admin around each event stops being rebuilt from scratch every time, and you find out who is coming before the day'],
  [/large catalogue with no reviews\/retention tooling/i,
    'reviews on the product pages, and something simple that brings past buyers back — a note when the thing they liked returns, or when the range they bought from grows. With a catalogue that size the hardest problem is helping someone choose, and other buyers do that better than you can'],
];

/**
 * What to say when a finding has no mapped explanation.
 *
 * Findings come from the model as well as the detector, so there will always be
 * ones this table has never seen. Without a fallback those emails lost their
 * whole third paragraph and arrived at about half the length — a problem
 * asserted and then dropped, which reads as thinner than saying nothing. This
 * is deliberately about the shape of the work rather than the specifics, since
 * the specifics are the part we do not have.
 */
const GENERIC_FIX = 'scoping it properly first: what is there now, what it should do instead, and the shortest route between the two. Work like this is usually more contained than it looks once someone has written it down, and knowing the size of it costs nothing';

/** How the finding would be fixed, or null when there is nothing specific to say. */
export function fixFor(rawFinding) {
  if (!rawFinding) return null;
  const t = String(rawFinding).trim();
  for (const [rx, phrase] of FIX) if (rx.test(t)) return t.replace(rx, phrase);
  return null;
}

const PLAIN_ENGLISH = [
  [/no mobile viewport meta.*/i, 'the site was never set up to work properly on phones'],
  [/entire web presence is a single-page link site/i, 'everything lives on one link page, which is doing your work a disservice'],
  [/(\d+) images with no lazy-loading or srcset.*/i, 'the images load at full size on mobile, which makes the site feel slow'],
  [/images have no width\/height.*/i, 'the page jumps around while the images load'],
  [/copyright still reads (\d{4})/i, 'the footer still says $1'],
  [/almost no copy.*/i, 'there is almost nothing on the site about who you are'],
  [/no meta description/i, 'the site has no description, so search results show whatever they can find'],
  [/(\w+) template with limited design control/i, 'the site is on a $1 template that limits how much it can look like you'],
  [/orders taken manually by DM or email.*/i, 'orders come through DMs rather than a proper checkout'],
  [/sells sessions or commissions with no booking flow.*/i, 'there is no way to book you from the site'],
  [/wholesale\/stockist programme with no ordering portal/i, 'stockists have no way to order without emailing you'],
  [/selling online with no email capture/i, 'nothing on the site captures emails from people who are not ready to buy'],
  [/runs events\/pop-ups.*/i, 'events and pop-ups are handled by hand'],
  [/large catalogue with no reviews\/retention tooling/i, 'a big catalogue with nothing bringing customers back'],
];

/**
 * Why a finding matters commercially.
 *
 * The drafts stated problems and stopped, which is why they read as
 * complaints rather than as a reason to reply. A finding without a
 * consequence gives the recipient nothing to act on.
 */
const CONSEQUENCE = [
  [/phones|mobile/i, 'most people who find you are on a phone, so that is the version of your brand they actually see'],
  [/one link page/i, 'anyone who wants to buy or commission has nowhere to go once they are interested'],
  [/images load at full size|feel slow/i, 'pages that take a few seconds to appear lose a large share of visitors before they ever load'],
  [/jumps around while the images load/i, 'people tap the wrong thing when the page moves under them, and on a phone that is most of your visitors'],
  [/footer still says/i, 'small signals like that make people wonder whether the business is still running'],
  [/nothing on the site about who you are/i, 'people buying from independent makers are buying the person as much as the product'],
  [/no description, so search results/i, 'search engines show whatever text they can scrape, which is rarely the sentence you would choose'],
  [/template that limits/i, 'the work ends up looking like everyone else on the same theme'],
  [/DMs rather than a proper checkout/i, 'every order costs you a conversation, and the ones who message outside your hours mostly do not come back'],
  [/no way to book you/i, 'interested people have to write an email and wait, which is where most enquiries quietly die'],
  [/stockists have no way to order/i, 'wholesale is the highest-value channel and it is running through your inbox'],
  [/captures emails/i, 'the visitors who are not ready to buy today leave without a trace'],
  [/events and pop-ups are handled by hand/i, 'that is recurring admin that software does once and then forgets about'],
  [/bringing customers back/i, 'repeat buyers are the cheapest revenue you have and nothing is prompting them'],
];

export function consequenceOf(finding) {
  if (!finding) return null;
  for (const [rx, why] of CONSEQUENCE) if (rx.test(finding)) return why;
  return null;
}

export function plainEnglish(finding) {
  if (!finding) return null;
  const t = String(finding).trim();
  for (const [rx, replacement] of PLAIN_ENGLISH) {
    if (rx.test(t)) return t.replace(rx, replacement);
  }
  return t;
}

/**
 * A name fit to appear in an email.
 *
 * When og:site_name and the title both fail, the name falls back to the bare
 * domain label, and a live draft opened "i was looking at heathceramics".
 * Split the run-together words where it is safe and capitalise.
 */
export function displayName(entity) {
  // Business names come from scraped <title> and og:site_name, so they are
  // attacker-controlled: anyone who owns a site the crawler visits chooses
  // this string. Strip control characters before it can reach a mail header.
  const raw = stripControl(entity?.display_name || entity?.domain?.split('.')[0] || '');
  if (!raw) return 'your site';

  // Already looks human: has a space or internal capitals.
  if (/\s/.test(raw) || /[a-z][A-Z]/.test(raw)) return raw;

  const word = raw.replace(/[-_]+/g, ' ').trim();
  if (word.includes(' ')) return word.replace(/\b[a-z]/g, (c) => c.toUpperCase());

  // A single lowercase run. Capitalising is safe; guessing word boundaries is
  // not, so we do not try to split "heathceramics" into two words.
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Remove anything that could break out of a header line.
 *
 * CR and LF are the ones that matter — a name like "Brand\nBcc: victim@x"
 * reaching a mail header is header injection. Other control characters go too,
 * since none of them belong in a business name.
 */
export function stripControl(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The same idea for a message BODY, where line breaks are the content.
 *
 * stripControl() must never be used on a body: it collapses \s+ to a single
 * space, which would flatten a whole email onto one line. Here CR and the other
 * control characters still go, \n survives, trailing spaces are trimmed per
 * line, and a run of blank lines is capped at one so an edited draft cannot
 * grow unbounded whitespace.
 */
export function stripControlKeepLines(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    // Every control character except \n (\u000a), which is the content here.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Does this body still carry the two things CAN-SPAM requires?
 *
 * A reviewer editing a draft can delete the footer without realising it is not
 * decoration. Sending without it is illegal, so the edit endpoint puts it back
 * rather than trusting that nobody will.
 */
export function hasCanSpamFooter(body, env) {
  const text = String(body || '');
  const addr = env?.SENDER_POSTAL_ADDRESS;
  const hasOptOut = /reply and let me know|will not write again|unsubscribe/i.test(text);
  const hasAddress = Boolean(addr) && text.includes(addr);
  return hasOptOut && hasAddress;
}

const firstName = (n) => String(n).trim().split(/\s+/)[0];
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * Take the first clause of an opportunity string and make it read like
 * English.
 *
 * Production drafts went out containing "specifically, system opportunity:
 * booking flow for workshops" - internal field labels leaking into copy a
 * real person was going to read. Strip them.
 */
function firstClause(s) {
  if (!s) return null;
  let out = String(s).split(/\s\|\s/)[0].trim();
  out = out.replace(/^(?:system|website|digital)\s*(?:opportunity|problem|issue)\s*[:\-—]\s*/i, '');
  out = out.replace(/^(?:opportunity|problem|issue)\s*[:\-—]\s*/i, '');
  out = out.replace(/\.$/, '').trim();
  return out || null;
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export { PERSONAS };
