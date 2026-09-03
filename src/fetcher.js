// Polite HTTP fetching.
//
// Rules, all deliberate:
//   - robots.txt is honoured, not consulted-then-ignored.
//   - one identifiable User-Agent, no rotation, no spoofing.
//   - hard timeout and a byte cap, so one bad page cannot eat the CPU budget.
//   - robots results are cached in memory for the invocation, so a run that
//     touches 40 pages on 10 domains fetches robots.txt 10 times, not 40.

const MAX_BYTES = 900_000;      // plenty for an HTML document
const TIMEOUT_MS = 12_000;

/**
 * SSRF guard.
 *
 * The crawler fetches whatever is in the frontier, and the frontier is fed by
 * links found on other people's websites. A hostile page could link to
 * localhost, a private range, or a cloud metadata endpoint to get the Worker
 * to fetch it on their behalf. Refuse anything that is not a public name.
 */
const PRIVATE_HOST = new RegExp([
  '^localhost$', '\\.localhost$', '^127\\.', '^0\\.', '^10\\.',
  '^169\\.254\\.',                                   // link-local / cloud metadata
  '^192\\.168\\.',
  '^172\\.(?:1[6-9]|2\\d|3[01])\\.',                   // 172.16-31
  '^\\[?::1\\]?$', '^\\[?f[cd][0-9a-f]{2}:',           // IPv6 loopback / unique-local
  '^\\[?fe80:',                                       // IPv6 link-local
  '\\.internal$', '\\.local$', '\\.lan$', '\\.home$',
  '^metadata\\.google', '^instance-data',
].join('|'), 'i');

/** True only for hostnames safe to fetch from a Worker. */
export function isPublicHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  if (PRIVATE_HOST.test(h)) return false;
  // A bare number or a hostname with no dot is never a real public site.
  if (!h.includes('.')) return false;
  return true;
}

export class Fetcher {
  constructor(userAgent) {
    this.ua = userAgent || 'LeadFinderBot/0.1';
    this.robots = new Map();     // host -> {rules, ok}
    this.fetched = 0;
  }

  async #robotsFor(host) {
    if (this.robots.has(host)) return this.robots.get(host);

    let parsed = { rules: [], ok: true };
    try {
      const res = await fetch(`https://${host}/robots.txt`, {
        headers: { 'User-Agent': this.ua, Accept: 'text/plain' },
        signal: AbortSignal.timeout(6000),
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (res.ok) {
        const text = (await res.text()).slice(0, 100_000);
        parsed = { rules: parseRobots(text, this.ua), ok: true };
      }
    } catch {
      // No robots.txt, or unreachable. Standard reading: allowed.
    }
    this.robots.set(host, parsed);
    return parsed;
  }

  async allowed(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (!isPublicHost(u.hostname)) return false;
    const { rules } = await this.#robotsFor(u.hostname);
    return isAllowed(rules, u.pathname + u.search);
  }

  /**
   * Fetch a page. Returns a result object rather than throwing, because a
   * dead site is data ("their website is down") not an exception.
   */
  async get(url) {
    const started = Date.now();
    try {
      if (!(await this.allowed(url))) {
        return { ok: false, error: 'robots-disallow', status: 0, url };
      }

      const res = await fetch(url, {
        headers: {
          'User-Agent': this.ua,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const ttfb = Date.now() - started;
      this.fetched++;

      const type = res.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(type)) {
        return { ok: false, error: `non-html:${type.split(';')[0]}`, status: res.status, ttfb, url };
      }

      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_BYTES * 3) {
        return { ok: false, error: 'too-large', status: res.status, ttfb, url };
      }

      let html = await res.text();
      const bytes = html.length;
      if (bytes > MAX_BYTES) html = html.slice(0, MAX_BYTES);

      return {
        ok: res.ok,
        status: res.status,
        html,
        bytes,
        ttfb,
        finalUrl: res.url || url,
        url,
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 200),
        status: 0,
        ttfb: Date.now() - started,
        url,
      };
    }
  }
}

/**
 * Parse robots.txt into the rule list that applies to us.
 *
 * A specific User-agent block for our bot wins outright; otherwise we use the
 * `*` block. Anything else is ignored.
 */
export function parseRobots(text, ua) {
  const token = (ua.split('/')[0] || '').toLowerCase();
  const groups = new Map();   // agent -> rules[]
  let current = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      if (!groups.has(agent)) groups.set(agent, []);
      current = groups.get(agent);
    } else if (field === 'allow' || field === 'disallow') {
      if (current) current.push({ type: field, path: value });
    }
  }

  for (const [agent, rules] of groups) {
    if (agent && agent !== '*' && token.includes(agent)) return rules;
  }
  return groups.get('*') || [];
}

/** Longest-match wins; Allow beats Disallow at equal length. */
export function isAllowed(rules, path) {
  let best = null;
  for (const r of rules) {
    if (r.path === '') continue;                 // empty Disallow means allow all
    if (!matchesPattern(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow')) {
      best = { type: r.type, len };
    }
  }
  return !best || best.type === 'allow';
}

function matchesPattern(pattern, path) {
  // robots.txt supports * and a trailing $.
  if (!pattern.includes('*') && !pattern.endsWith('$')) return path.startsWith(pattern);
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = new RegExp(
    '^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') +
    (anchored ? '$' : '')
  );
  return rx.test(path);
}

/** Stable content hash, so we can skip re-analysing an unchanged page. */
export async function contentHash(text) {
  const normalized = String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
