// Session authentication for the dashboard.
//
// Google OAuth was removed in favor of Cloudflare Access. The signed session
// cookie remains the fallback for the shared dashboard key and for local
// deployments where Access is not in front of the Worker.

const SESSION_COOKIE = '__Host-lf_session';
const SESSION_HOURS = 12;
const enc = new TextEncoder();

/** Who is allowed in. Comma-separated in ALLOWED_EMAILS. */
export function allowedEmails(env) {
  return String(env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
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

  if (data.e === 'dashboard-key') return data.e;
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

const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

const clearCookie = (name) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': clearCookie(SESSION_COOKIE),
      'cache-control': 'no-store',
    },
  });
}

export function sessionFrom(request) {
  return readCookie(request, SESSION_COOKIE);
}

/**
 * Trade a URL key for a short-lived signed session and remove the key from
 * the address bar. This is the only browser credential exchange needed when
 * Cloudflare Access is not available.
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

// Compatibility exports keep older deployments from failing at module load
// time. Google authentication itself is intentionally unavailable: Access is
// now the supported identity provider.
export function googleConfigured() {
  return false;
}

export function startLogin() {
  return new Response(JSON.stringify({ error: 'Google sign-in has been removed; use Cloudflare Access.' }), {
    status: 410,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function completeLogin() {
  return new Response(JSON.stringify({ error: 'Google sign-in has been removed; use Cloudflare Access.' }), {
    status: 410,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
