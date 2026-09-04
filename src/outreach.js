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
    subject: (n) => `your ${n} site + one thing i noticed`,
    open: (liked) => `i fell down a rabbit hole on your site and ${liked} genuinely stopped me`,
    bridge: 'the pieces have so much attitude, and right now the site is the flattest part of the whole thing',
    cta: 'want me to mock up what the shop page could look like? no strings, i just want to make it',
    sign: '—lucia',
  },
  craft_goods: {
    label: 'Handmade & craft',
    subject: (n) => `${n} — a small note about your shop page`,
    open: (liked) => `i came across your work and ${liked} is lovely`,
    bridge: 'the making is clearly the good part, and the site is not quite carrying it yet',
    cta: 'happy to sketch out how the shop could feel closer to the actual objects — want me to?',
    sign: '— lucia',
  },
  beauty_wellness: {
    label: 'Beauty & skincare',
    subject: (n) => `quick thought on the ${n} site`,
    open: (liked) => `i was looking through your range and ${liked} caught me`,
    bridge: 'the product story is strong; the site is not letting people feel it before they buy',
    cta: 'i could put together a short walkthrough of what i would change on the product pages — useful?',
    sign: '— lucia',
  },
  food_bev: {
    label: 'Food & beverage',
    subject: (n) => `${n} — one idea for the site`,
    open: (liked) => `found you recently and ${liked} sold me immediately`,
    bridge: 'the brand has real appetite to it, and the site is the one place that goes quiet',
    cta: 'want a quick teardown of the ordering flow? takes me ten minutes and it is yours either way',
    sign: '— lucia',
  },
  artist_portfolio: {
    label: 'Artist portfolio',
    subject: (n) => `your work + your site (a note)`,
    open: (liked) => `i spent a while with your work and ${liked} really got me`,
    bridge: 'the work deserves a proper home — right now it is living somewhere much smaller than it is',
    cta: 'i would love to show you a rough layout for a real portfolio site. want me to put one together?',
    sign: '— lucia',
  },
  creative_studio: {
    label: 'Creative studio',
    subject: (n) => `${n} — a thought on your own site`,
    open: (liked) => `been looking at your work and ${liked} stands out`,
    bridge: 'you clearly do this well for clients; your own site and internal workflow are the usual casualty',
    cta: 'open to a short conversation about it? i work with studios on exactly this',
    sign: '— Lucia',
  },
  lifestyle_brand: {
    label: 'Creative lifestyle brand',
    subject: (n) => `a note on the ${n} site`,
    open: (liked) => `came across your brand and ${liked} is really nice`,
    bridge: 'the identity is there; the site is not quite keeping up with it',
    cta: 'want me to put together a quick visual of what it could be? genuinely no pressure',
    sign: '— lucia',
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

  // The evidence rule, enforced at the last possible moment.
  if (!p.liked || p.evidence_rejected) return null;

  // Reject compliments that are attribute lists rather than observations.
  // Production produced "aesthetic personality and unique products stands
  // out" - grammatically broken and true of any brand. If it does not name
  // something concrete, no draft goes out.
  if (!isSpecificCompliment(p.liked)) return null;

  const opportunity = p.opportunity || firstClause(entity.website_opportunity) || firstClause(entity.system_opportunity);
  if (!opportunity) return null;

  const name = entity.display_name || entity.domain || 'your';
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
    `${persona.bridge} — specifically, ${lowerFirst(opportunity)}`,
    '',
    ctaFor(persona, entity, det),
    '',
    signOff(env, persona),
    '',
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
    'i build sites for small creative businesses, and this is the kind of project i actually enjoy: something small, well made, that looks like you rather than a template.',
    '',
    'if you ever want one, i would happily put together a rough idea of what it could look like first, free, so you can see it before deciding anything.',
    '',
    signOff(env, persona),
    '',
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
  const n = env?.SENDER_NAME;
  if (n && n !== 'Lucia') return `— ${n}`;
  return persona.sign;
}

/**
 * CAN-SPAM requires a real physical postal address and a working opt-out in
 * every commercial message. This is not optional and not decorative.
 */
export function canSpamFooter(env) {
  const addr = env?.SENDER_POSTAL_ADDRESS || '[SET SENDER_POSTAL_ADDRESS]';
  const email = env?.SENDER_EMAIL || '[SET SENDER_EMAIL]';
  return [
    '---',
    `${addr}`,
    `Not interested? Reply "unsubscribe" to ${email} and I won't contact you again.`,
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
