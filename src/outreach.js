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
 * `context` is how Lucia describes what she does to THIS kind of business —
 * the credibility line. `offer` is the concrete thing she will send, which is
 * what earns a reply: a request for "a quick chat" asks the recipient to
 * spend time, an offer to send something specific gives them a reason to.
 */
const PERSONAS = {
  alt_fashion: {
    label: 'Alternative fashion',
    subject: (n) => `${n} — a few notes on your site`,
    open: (liked) => `I came across ${'{BRAND}'} recently and spent a while on your site. ${liked} is genuinely great`,
    context: 'I design and build websites for independent fashion labels — the kind where the site needs to carry as much personality as the clothes do.',
    offer: 'a short written breakdown of what I would change on the shop pages, with a rough visual of how it could look',
    sign: 'Lucía Adams',
  },
  craft_goods: {
    label: 'Handmade & craft',
    subject: (n) => `${n} — a few notes on your shop pages`,
    open: (liked) => `I came across your work this week and spent some time with it. ${liked} is lovely`,
    context: 'I design and build websites for independent makers and studios, so the site does justice to work that is made by hand.',
    offer: 'a short written breakdown of what I would change, with a rough visual of how the shop could feel closer to the objects themselves',
    sign: 'Lucía Adams',
  },
  beauty_wellness: {
    label: 'Beauty & skincare',
    subject: (n) => `${n} — notes on your product pages`,
    open: (liked) => `I was looking through your range this week and ${liked} stayed with me`,
    context: 'I design and build websites for independent beauty and skincare brands, where most of the decision happens on the product page.',
    offer: 'a short written breakdown of what I would change on the product pages, and why',
    sign: 'Lucía Adams',
  },
  food_bev: {
    label: 'Food & beverage',
    subject: (n) => `${n} — a thought on your ordering flow`,
    open: (liked) => `I came across ${'{BRAND}'} recently and ${liked} sold me immediately`,
    context: 'I design and build websites and ordering systems for small food and drink brands.',
    offer: 'a short teardown of the ordering flow with the specific changes I would make',
    sign: 'Lucía Adams',
  },
  artist_portfolio: {
    label: 'Artist portfolio',
    subject: () => `Your work and where it lives`,
    open: (liked) => `I spent a while with your work today. ${liked} really stayed with me`,
    context: 'I design and build portfolio sites for artists and illustrators — properly built, not a template with your images dropped in.',
    offer: 'a rough layout for what a real portfolio site could look like for your work',
    sign: 'Lucía Adams',
  },
  creative_studio: {
    label: 'Creative studio',
    subject: (n) => `${n} — a note on your own site`,
    open: (liked) => `I have been looking through your work and ${liked} stands out`,
    context: 'I build websites and internal tools for creative studios — usually the work that gets postponed because client projects come first.',
    offer: 'a short written assessment of your site and the workflow around it, with what I would prioritise',
    sign: 'Lucía Adams',
  },
  lifestyle_brand: {
    label: 'Creative lifestyle brand',
    subject: (n) => `${n} — a few notes on your site`,
    open: (liked) => `I came across ${'{BRAND}'} recently and ${liked} is really nice`,
    context: 'I design and build websites for independent brands with a clear identity of their own.',
    offer: 'a short written breakdown of what I would change, with a rough visual of where it could go',
    sign: 'Lucía Adams',
  },
};

/** CTA chosen by which opportunity is actually the strongest. */
function ctaFor(persona, entity, det) {
  const systemLed = det?.system_need > det?.website_need;
  if (systemLed) {
    return 'i had one specific idea for how to take that off your plate — want me to write it up? two minutes to read, no pitch attached';
  }
  return persona.cta;
}

/**
 * Compose a draft. Returns null when there is nothing honest to say.
 *
 * @returns {{subject, body, cta, persona}|null}
 */
export function composeDraft(entity, env) {
  const persona = PERSONAS[entity.niche] || PERSONAS.lifestyle_brand;
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

  // The evidence rule. A compliment must be real: backed by page text, and
  // specific rather than an attribute list.
  const hasRealCompliment =
    Boolean(p.liked) && !p.evidence_rejected && isSpecificCompliment(p.liked);

  // No honest compliment does NOT mean no email.
  //
  // Requiring one was dropping 46 of 120 leads in a single queue build — more
  // than a third — including businesses with a perfectly concrete, measured
  // problem worth writing about. The rule that matters is "never invent
  // praise", not "never write without praise". So when there is nothing real
  // to admire, the email simply opens on the observation instead.
  if (!hasRealCompliment) return composeObservationDraft(entity, env, persona, opportunity);

  const name = displayName(entity);
  const greeting = entity.founder_name ? `Hi ${firstName(entity.founder_name)},` : 'Hello,';

  const det = {
    website_need: entity.website_opportunity ? 1 : 0,
    system_need: entity.system_opportunity ? 2 : 0,
  };

  const finding = plainEnglish(opportunity);
  const why = consequenceOf(finding);

  const body = [
    greeting,
    '',
    `${fixCaps(persona.open(lowerFirst(p.liked)).replace('{BRAND}', name))}.`,
    '',
    `I'm Lucía Adams. ${persona.context}`,
    '',
    why
      ? `Looking at your site, one thing stood out: ${lowerFirst(finding)}. ${sentence(why)}`
      : `Looking at your site, one thing stood out: ${lowerFirst(finding)}.`,
    '',
    `If it would be useful, I can put together ${persona.offer} — free, and with no expectation that you work with me afterwards.`,
    '',
    'Would you like me to send it over this week?',
    signature(),
    canSpamFooter(env),
  ].filter((l) => l !== undefined && l !== null).join('\n');

  return {
    subject: stripControl(persona.subject(name)).slice(0, 200),
    body,
    cta: persona.offer,
    persona: entity.niche || 'lifestyle_brand',
  };
}

/**
 * Draft that leads with the observation rather than a compliment.
 *
 * Used when nothing evidence-backed was found to admire. It says less, and
 * what it says is true, which is the whole point. Still shorter than the
 * complimented version because there is less to legitimately say.
 */
function composeObservationDraft(entity, env, persona, opportunity) {
  if (!entity.contact_email) return null;

  const name = displayName(entity);
  const greeting = entity.founder_name ? `Hi ${firstName(entity.founder_name)},` : 'Hello,';

  const finding = plainEnglish(opportunity);
  const why = consequenceOf(finding);

  const body = [
    greeting,
    '',
    `I came across ${name} this week and spent some time on your site.`,
    '',
    `I'm Lucía Adams. ${persona.context}`,
    '',
    why
      ? `One thing stood out: ${lowerFirst(finding)}. ${sentence(why)}`
      : `One thing stood out: ${lowerFirst(finding)}.`,
    '',
    `If it would be useful, I can put together ${persona.offer} — free, and with no expectation that you work with me afterwards.`,
    '',
    'Would you like me to send it over this week?',
    signature(),
    canSpamFooter(env),
  ].filter((l) => l !== undefined && l !== null).join('\n');

  return {
    subject: stripControl(`${name} — a few notes on your site`).slice(0, 200),
    body,
    cta: 'observation-led',
    persona: `${entity.niche || 'lifestyle_brand'}:observation`,
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
    observation,
    '',
    point,
    '',
    `I'm Lucía Adams. ${persona.context}`,
    '',
    'If it would be useful, I can put together a rough idea of what a site could look like for you — free, and with no expectation that you work with me afterwards.',
    '',
    'Would you like me to send it over this week?',
    signature(),
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
 * No signature in the draft body.
 *
 * The mail client appends the real one. Two signatures in a single email is
 * the clearest possible tell that the message was machine-assembled, which is
 * exactly the impression this outreach is trying to avoid.
 *
 * The CAN-SPAM footer is separate and still required — a postal address and a
 * working opt-out are legal obligations, not a sign-off.
 */
function signature() {
  return null;
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
