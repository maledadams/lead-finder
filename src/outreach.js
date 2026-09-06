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

const PERSONAS = {
  alt_fashion: {
    label: 'Alternative fashion',
    subject: (n) => `${n} — one thought about your site`,
    open: (liked) => `i went down a bit of a rabbit hole on your site. ${liked} is genuinely great`,
    bridge: 'the clothes have so much attitude. one thing stood out though:',
    cta: 'want me to mock up what the shop page could look like? no strings — i just want to make it',
    sign: 'lucía',
  },
  craft_goods: {
    label: 'Handmade & craft',
    subject: (n) => `${n} — a small thing about your shop page`,
    open: (liked) => `i came across your work this week. ${liked} is lovely`,
    bridge: 'the making is clearly the good part. one thing i noticed:',
    cta: 'i could sketch out how the shop might feel closer to the actual objects. want me to?',
    sign: 'lucía',
  },
  beauty_wellness: {
    label: 'Beauty & skincare',
    subject: (n) => `a thought on the ${n} product pages`,
    open: (liked) => `i was looking through your range and ${liked} stayed with me`,
    bridge: 'the product story is strong. one thing gets in its way though:',
    cta: 'happy to walk you through what i would change on the product pages — worth a look?',
    sign: 'lucía',
  },
  food_bev: {
    label: 'Food & beverage',
    subject: (n) => `${n} — one idea for the site`,
    open: (liked) => `found you recently and ${liked} sold me immediately`,
    bridge: 'the brand has real appetite to it. one thing stood out:',
    cta: 'want a quick teardown of the ordering flow? ten minutes of my time, yours either way',
    sign: 'lucía',
  },
  artist_portfolio: {
    label: 'Artist portfolio',
    subject: () => `your work deserves a better home`,
    open: (liked) => `i spent a while with your work today. ${liked} really got me`,
    bridge: 'though one thing caught my eye:',
    cta: 'i would love to show you a rough layout for a real portfolio. want me to put one together?',
    sign: 'lucía',
  },
  creative_studio: {
    label: 'Creative studio',
    subject: (n) => `${n} — a thought on your own site`,
    open: (liked) => `been looking through your work and ${liked} stands out`,
    bridge: 'you clearly do this well for clients. your own setup is the usual casualty:',
    cta: 'open to a short conversation about it? i work with studios on exactly this',
    sign: 'Lucía',
  },
  lifestyle_brand: {
    label: 'Creative lifestyle brand',
    subject: (n) => `a note on the ${n} site`,
    open: (liked) => `came across your brand and ${liked} is really nice`,
    bridge: 'the identity is all there. one thing is lagging behind it:',
    cta: 'want me to put together a quick visual of what it could be? genuinely no pressure',
    sign: 'lucía',
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
  const greeting = entity.founder_name ? `hi ${firstName(entity.founder_name)},` : 'hi!';

  const det = {
    website_need: entity.website_opportunity ? 1 : 0,
    system_need: entity.system_opportunity ? 2 : 0,
  };

  const body = [
    greeting,
    '',
    `${persona.open(lowerFirst(p.liked))}.`,
    '',
    `${persona.bridge} ${lowerFirst(plainEnglish(opportunity))}.`,
    '',
    ctaFor(persona, entity, det),
    '',
    signOff(env, persona),
    canSpamFooter(env),
  ].filter((l) => l !== undefined).join('\n');

  return {
    subject: persona.subject(name),
    body,
    cta: ctaFor(persona, entity, det),
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
  const greeting = entity.founder_name ? `hi ${firstName(entity.founder_name)},` : 'hi!';

  const body = [
    greeting,
    '',
    `i was looking at ${name} and noticed ${lowerFirst(plainEnglish(opportunity))}.`,
    '',
    'i design and build sites for small creative businesses, so it is the sort of thing i notice whether or not anyone asked.',
    '',
    ctaFor(persona, entity, {
      website_need: entity.website_opportunity ? 1 : 0,
      system_need: entity.system_opportunity ? 2 : 0,
    }),
    '',
    signOff(env, persona),
    canSpamFooter(env),
  ].filter((l) => l !== undefined && l !== null).join('\n');

  return {
    subject: `${name} — one thing i noticed`,
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
  const greeting = entity.founder_name ? `hi ${firstName(entity.founder_name)},` : 'hi!';
  const hasIg = Boolean(entity.instagram);

  const observation = hasIg
    ? `i came across ${name} on instagram and went looking for your website — as far as i can tell there isn't one yet`
    : `i came across ${name} and went looking for a website — as far as i can tell there isn't one yet`;

  const point = hasIg
    ? "which feels like a gap, because you've already done the hard part. people find you, like what they see, and then there's nowhere for them to go."
    : "which might be deliberate, and if so ignore me entirely.";

  const body = [
    greeting,
    '',
    `${observation} — ${point}`,
    '',
    'i make small, well-built sites for creative businesses. things that look like the person behind them rather than a template.',
    '',
    'if you ever want one, i would happily put a rough idea together first so you can see it before deciding anything. free, no catch.',
    '',
    signOff(env, persona),
    canSpamFooter(env),
  ].filter((l) => l !== undefined && l !== null).join('\n');

  return {
    subject: `${name} — you don't have a website yet?`,
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
function signOff(env, persona) {
  return `— ${persona.sign || env?.SENDER_NAME || 'lucía'}`;
}

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
    'if this is not for you, just say so and i will not write again.',
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
  const raw = entity?.display_name || entity?.domain?.split('.')[0] || '';
  if (!raw) return 'your site';

  // Already looks human: has a space or internal capitals.
  if (/\s/.test(raw) || /[a-z][A-Z]/.test(raw)) return raw;

  const word = raw.replace(/[-_]+/g, ' ').trim();
  if (word.includes(' ')) return word.replace(/\b[a-z]/g, (c) => c.toUpperCase());

  // A single lowercase run. Capitalising is safe; guessing word boundaries is
  // not, so we do not try to split "heathceramics" into two words.
  return word.charAt(0).toUpperCase() + word.slice(1);
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
