// Browser rendering, used as a last resort.
//
// The evaluator is fetch + regex, with no browser. That is fast, costs almost
// nothing, and works for most independent brand sites, which are Shopify or
// Squarespace and ship real HTML.
//
// It fails completely on a JS-rendered site: a React shell yields one word of
// text and zero images, so the audit sees an empty page and the business
// looks dead when it is not.
//
// Cloudflare Browser Rendering fixes that from inside a Worker. Browserless
// would need a Docker host that stays on, which is the constraint this whole
// project is built to avoid.
//
// It is METERED, so it is deliberately the exception:
//   - only when the static fetch produced almost nothing
//   - only for candidates that already look worth it
//   - hard daily cap of its own, separate from the fetch budget

const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts';
const TIMEOUT_MS = 30_000;

/**
 * Does this page need a browser?
 *
 * The signature of a JS-rendered site: almost no text, almost no images, but
 * scripts present. A genuinely empty page has no scripts either, and should
 * be rejected rather than re-fetched at cost.
 */
export function needsBrowser(signals, html) {
  if (!signals) return false;
  const thin = (signals.word_count || 0) < 60 && (signals.img_count || 0) < 4;
  if (!thin) return false;

  const scripts = (String(html || '').match(/<script\b/gi) || []).length;
  if (scripts < 2) return false;                     // genuinely empty, not JS

  // Known SPA roots and bundlers.
  return /id=["'](root|app|__next|__nuxt|svelte)["']|webpack|vite|_next\/static|nuxt|react|angular/i
    .test(String(html || ''));
}

/**
 * Render a URL and return its HTML. Returns null on any failure — a metered
 * service being unavailable must never break the crawl.
 */
export async function renderPage(env, url) {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !token) return { html: null, error: 'browser-rendering-not-configured' };

  try {
    const res = await fetch(`${ENDPOINT}/${accountId}/browser-rendering/content`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle0', timeout: 20000 },
challenge: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return { html: null, error: `http-${res.status}` };
    const data = await res.json();
    if (!data?.success || typeof data.result !== 'string') {
      return { html: null, error: 'unexpected-shape' };
    }
    return { html: data.result.slice(0, 900_000), error: null };
  } catch (err) {
    return {
      html: null,
      error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 120),
    };
  }
}
