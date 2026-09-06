// Google sign-in for the people who use the dashboard.
//
// WHY NOT CLOUDFLARE ACCESS
//
// Access would be the obvious answer, and it is a good product. The deploy
// token here has read-only Access permission, so the app and its policy
// cannot be created from code — and Access with Google still requires
// registering an OAuth client in Google Cloud anyway. Doing it in the Worker
// is one setup step instead of two, and everything about it is visible in
// this repository rather than in a console.
//
// HOW IT WORKS
//
//   /auth/login     -> redirect to Google, with a signed state cookie
//   /auth/callback  -> exchange the code, check the email, set a session
//   /auth/logout    -> clear the session
//
// The session is an HMAC-signed cookie. It carries the email and an expiry
// and nothing else, so it cannot be tampered with and does not need storage.
//
// The shared key still works, for scripts and cron. Humans get Google.

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

const SESSION_COOKIE = '__Host-lf_session';
const STATE_COOKIE = '__Host-lf_state';
const SESSION_HOURS = 12;

const enc = new TextEncoder();

/** Who is allowed in. Comma-separated in ALLOWED_EMAILS. */
export function allowedEmails(env) {
  return String(env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Google sign-in counts as configured only with real credentials.
 *
 * Placeholders are truthy, which is worse than useless: the dashboard offered
 * a "Continue with Google" button that could only ever fail, because the
 * client id was still the literal string REPLACE_WITH_... Treat obvious
 * placeholders as absent so the shared key remains the way in.
 */
const PLACEHOLDER = /^(?:replace|placeholder|todo|changeme|set-?me|xxx)/i;

export function googleConfigured(env) {
  const id = env.GOOGLE_CLIENT_ID || '';
  const secret = env.GOOGLE_CLIENT_SECRET || '';
  if (!id || !secret || !env.SESSION_SECRET) return false;
  if (PLACEHOLDER.test(id) || PLACEHOLDER.test(secret)) return false;
  // A real Google web client id always carries this suffix.
  return id.endsWith('.apps.googleusercontent.com');
}

async function hmac(secret, message) {
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

/** Start the Google flow. */
export async function startLogin(env, request) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/callback`;

  // CSRF protection: a random value held in a cookie and echoed by Google.
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const state = `${nonce}.${await hmac(env.SESSION_SECRET, nonce)}`;

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    // Google will only return accounts on this domain if one is set, but the
    // allowlist below is the real gate either way.
    ...(env.GOOGLE_HD ? { hd: env.GOOGLE_HD } : {}),
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${GOOGLE_AUTH}?${params}`,
      'set-cookie': cookie(STATE_COOKIE, state, 600),
      'cache-control': 'no-store',
    },
  });
}

/**
 * Complete the flow.
 *
 * Returns a Response — either a redirect with a session cookie set, or an
 * error page. The email is checked against the allowlist before any session
 * exists, so an unlisted Google account gets nothing.
 */
export async function completeLogin(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = readCookie(request, STATE_COOKIE);

  if (!code) return deny('No authorization code returned.');
  if (!state || !cookieState || !constantTimeEqual(state, cookieState)) {
    return deny('Sign-in could not be verified. Please try again.');
  }
  // The state must also carry our own signature, so a forged cookie pair fails.
  const [nonce, sig] = state.split('.');
  if (!constantTimeEqual(sig || '', await hmac(env.SESSION_SECRET, nonce || ''))) {
    return deny('Sign-in could not be verified. Please try again.');
  }

  let tokens;
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/auth/callback`,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return deny('Google rejected the sign-in.');
    tokens = await res.json();
  } catch {
    return deny('Could not reach Google.');
  }

  // The id_token came straight from Google over TLS in exchange for our client
  // secret, so its contents are trustworthy without re-verifying the
  // signature. We still check the audience and that the address is verified.
  const claims = decodeJwtPayload(tokens?.id_token);
  if (!claims) return deny('Google returned an unreadable token.');
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return deny('Token was issued for another application.');
  if (claims.email_verified === false) return deny('That Google account has no verified email.');

  const email = String(claims.email || '').toLowerCase();
  if (!email) return deny('Google did not return an email address.');

  if (!allowedEmails(env).includes(email)) {
    return deny(`${email} is not on the access list for this tool.`, 403);
  }

  const session = await signSession(env, email);
  return new Response(null, {
    status: 302,
    headers: [
      ['location', '/'],
      ['set-cookie', cookie(SESSION_COOKIE, session, SESSION_HOURS * 3600)],
      ['set-cookie', clearCookie(STATE_COOKIE)],
      ['cache-control', 'no-store'],
    ],
  });
}

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

/** The sign-in page. Deliberately plain: one button, no explanation needed. */
export function loginPage(message = '') {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>
<style>
  :root{--bg:#f7f5f3;--card:#fff;--ink:#1a1918;--dim:#6d6763;--line:#e5dfd9;--no:#b4472f}
  @media (prefers-color-scheme:dark){:root{--bg:#141312;--card:#1d1b1a;--ink:#f1ede9;
    --dim:#9b938c;--line:#312e2b;--no:#e2795c}}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);
       color:var(--ink);font:16px/1.6 ui-sans-serif,-apple-system,system-ui,sans-serif}
  .box{background:var(--card);border:1px solid var(--line);border-radius:16px;
       padding:36px 40px;text-align:center;max-width:380px;margin:20px}
  h1{font-size:19px;margin:0 0 6px;letter-spacing:-.02em}
  p{color:var(--dim);font-size:14px;margin:0 0 22px}
  .err{color:var(--no);font-size:14px;margin-bottom:18px}
  a.btn{display:inline-flex;align-items:center;gap:10px;background:var(--ink);color:var(--bg);
        text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:15px}
</style></head><body><div class="box">
  <h1>Lead review</h1>
  <p>Sign in with the Google account you were given access with.</p>
  ${message ? `<div class="err">${message.replace(/[<>&]/g, '')}</div>` : ''}
  <a class="btn" href="/auth/login">Continue with Google</a>
</div></body></html>`, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function deny(message, status = 401) {
  const res = loginPage(message);
  return new Response(res.body, { status, headers: res.headers });
}
