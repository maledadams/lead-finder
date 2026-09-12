// Sessions.
//
// Cloudflare Access is the login. It sits in front of the custom domain,
// authenticates whoever is asking, and forwards a signed assertion — so this
// Worker has no sign-in page and no OAuth flow of its own. A Google login used
// to live here and was unreachable behind Access; it is gone, along with the two
// credentials it asked people to configure.
//
// What remains is the session cookie, for the one case Access does not cover:
// opening the dashboard with ?key= and the shared key. The key is swapped for an
// HMAC-signed cookie so the credential leaves the address bar and the browser
// history. The cookie carries an email and an expiry and nothing else, so it
// cannot be tampered with and needs no storage.
//
//   /auth/logout  -> clear the session

const SESSION_COOKIE = '__Host-lf_session';
const SESSION_HOURS = 12;

const enc = new TextEncoder();

/**
 * Google sign-in counts as configured only with real credentials.
 *
 * Placeholders are truthy, which is worse than useless: the dashboard offered
 * a "Continue with Google" button that could only ever fail, because the
 * client id was still the literal string REPLACE_WITH_... Treat obvious
 * placeholders as absent so the shared key remains the way in.
 */
/** Who is allowed in. Comma-separated in ALLOWED_EMAILS. */
export function allowedEmails(env) {
  return String(env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function hmac(secret, message) {
  // An unset SESSION_SECRET reaches WebCrypto as a zero-length key and comes
  // back as "Imported HMAC key length (0) must be a non-zero value…", which
  // says nothing about what is actually wrong. Signing with an empty secret
  // would be worse: every session cookie would be forgeable.
  //
  // Deliberately only the empty case. A short secret is weak but it WORKS, and
  // a length rule added later would lock an existing deployment out of its own
  // dashboard on the next deploy — a worse outcome than the weakness.
  if (!secret) {
    throw new Error('SESSION_SECRET is not set — run: wrangler secret put SESSION_SECRET');
  }
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64url(new Uint8Array(sig));
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Build a signed session token: base64(payload).signature */
async function signSession(env, email) {
  const payload = b64url(enc.encode(JSON.stringify({
    e: email,
    x: Date.now() + SESSION_HOURS * 3600_000,
  })));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

/** Verify a session token. Returns the email, or null. */
export async function verifySession(env, token) {
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;

  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!constantTimeEqual(sig, expected)) return null;

  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    ));
  } catch {
    return null;
  }
  if (!data?.e || !data?.x || Date.now() > data.x) return null;

  // A session minted from the shared key is not a person and has no entry in
  // the allowlist; the key itself was the credential.
  if (data.e === 'dashboard-key') return data.e;

  // Re-check the allowlist on every request, so removing someone takes effect
  // immediately rather than when their cookie happens to expire.
  if (!allowedEmails(env).includes(String(data.e).toLowerCase())) return null;

  return data.e;
}

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// __Host- prefixed cookies must be Secure, path=/, and carry no Domain. That
// pins them to this exact hostname, which is what we want for a dashboard.
const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

const clearCookie = (name) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      location: '/auth/login',
      'set-cookie': clearCookie(SESSION_COOKIE),
      'cache-control': 'no-store',
    },
  });
}

export function sessionFrom(request) {
  return readCookie(request, SESSION_COOKIE);
}

/**
 * Trade a URL key for a session cookie.
 *
 * The dashboard was opened as ?key=<secret>, which puts a long-lived
 * credential in the address bar, browser history, and anything that reads a
 * URL over someone's shoulder. Presenting it once is unavoidable — it is the
 * only credential there is — but keeping it there is not.
 *
 * So a valid key is exchanged immediately for the same signed session cookie
 * that Google sign-in produces, and the browser is redirected to the clean
 * URL. The key never appears again.
 */
export async function exchangeKeyForSession(env, url) {
  const session = await signSession(env, 'dashboard-key');
  const clean = new URL(url);
  clean.searchParams.delete('key');

  return new Response(null, {
    status: 302,
    headers: {
      location: clean.pathname + (clean.search || ''),
      'set-cookie': cookie(SESSION_COOKIE, session, SESSION_HOURS * 3600),
      'cache-control': 'no-store',
    },
  });
}

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    return JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    ));
  } catch {
    return null;
  }
}

