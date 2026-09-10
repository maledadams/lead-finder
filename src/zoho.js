// Sending through Zoho Mail.
//
// Two routes existed. Zoho's SMTP would mean hand-writing SMTP over TLS on
// raw sockets from a Worker — far more code, and far more ways to fail
// silently on a cold email. The REST API is plain HTTPS and is what this uses.
//
// AUTHORISATION
//
// OAuth 2.0, authorised once by a human. The refresh token that comes back is
// long-lived and lives in D1 rather than in the repository; access tokens last
// about an hour and are fetched on demand and cached alongside it.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not send on its own. Every message goes out because a person read it
// and pressed a button. The system has sent nothing yet, its scoring is
// uncalibrated, and it has already produced drafts that should not have gone
// anywhere — a pitch addressed to hr@, an internal field label in the body.
// Those were caught by a human reading the queue.

const REGIONS = {
  com: { accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com' },
  eu: { accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', mail: 'https://mail.zoho.in' },
  au: { accounts: 'https://accounts.zoho.com.au', mail: 'https://mail.zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', mail: 'https://mail.zoho.jp' },
};

// Only what is needed: read the account list and the signature, send, and read
// message headers so bounces can be detected. Nothing here can modify or delete
// existing mail — every scope is READ or CREATE.
//
// messages.READ was added after the first release. An existing connection was
// granted without it, so bounce sync reports "reconnect Zoho" until the consent
// screen is visited again; sending is unaffected.
export const ZOHO_SCOPES =
  'ZohoMail.accounts.READ,ZohoMail.messages.CREATE,ZohoMail.messages.READ';

function region(env) {
  return REGIONS[(env.ZOHO_REGION || 'com').toLowerCase()] || REGIONS.com;
}

/**
 * Whether sending can even be attempted.
 *
 * A placeholder counts as unconfigured, exactly as it does for Google sign-in.
 * Without that check a REPLACE_WITH_ value flows straight into an OAuth request
 * and Zoho answers "invalid client", which says nothing about where to look —
 * that shipped for a day and broke sending on every profile.
 */
const PLACEHOLDER = /^(?:replace|placeholder|todo|changeme|set-?me|xxx)/i;

export function zohoConfigured(env) {
  const id = env.ZOHO_CLIENT_ID || '';
  const secret = env.ZOHO_CLIENT_SECRET || '';
  if (!id || !secret) return false;
  return !PLACEHOLDER.test(id) && !PLACEHOLDER.test(secret);
}

// --- settings ---------------------------------------------------------------

export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

export async function setSetting(db, key, value) {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

export async function zohoConnected(db) {
  return Boolean(await getSetting(db, 'zoho_refresh_token'));
}

// --- oauth ------------------------------------------------------------------

// The callback cannot carry the dashboard key: Zoho redirects the browser back
// with only ?code and ?state, so a key-guarded callback rejects the very
// request it exists to receive. The state is signed instead, which proves the
// flow was started by someone who was authenticated at the time.
const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A state value only this Worker could have produced, valid for 15 minutes. */
export async function signState(env) {
  const nonce = `${Date.now()}`;
  return `${nonce}.${await hmac(env.SESSION_SECRET || env.ZOHO_CLIENT_SECRET, nonce)}`;
}

export async function verifyState(env, state) {
  const [nonce, sig] = String(state || '').split('.');
  if (!nonce || !sig) return false;
  const expected = await hmac(env.SESSION_SECRET || env.ZOHO_CLIENT_SECRET, nonce);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;
  return Date.now() - Number(nonce) < 15 * 60_000;
}

/** Where the user is sent to grant access. */
export function authorizeUrl(env, redirectUri, state) {
  const params = new URLSearchParams({
    scope: ZOHO_SCOPES,
    client_id: env.ZOHO_CLIENT_ID,
    response_type: 'code',
    // Offline is what produces a refresh token; without it the grant expires
    // in an hour and sending stops working the same day it is set up.
    access_type: 'offline',
    redirect_uri: redirectUri,
    prompt: 'consent',
    state,
  });
  return `${region(env).accounts}/oauth/v2/auth?${params}`;
}

/** Exchange the one-time code for a refresh token and store it. */
export async function exchangeCode(env, db, code, redirectUri) {
  const res = await fetch(`${region(env).accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) return { ok: false, error: data.error || `http-${res.status}` };
  if (!data.refresh_token) {
    // Zoho only returns one on the first consent for a given client.
    return { ok: false, error: 'no-refresh-token-returned (revoke the app in Zoho and retry)' };
  }

  await setSetting(db, 'zoho_refresh_token', data.refresh_token);
  await cacheAccessToken(db, data.access_token, data.expires_in);

  const account = await fetchAccount(env, data.access_token);
  if (account.ok) {
    await setSetting(db, 'zoho_account_id', account.accountId);
    await setSetting(db, 'zoho_from_address', account.primaryAddress || '');
  }

  return { ok: true, account: account.ok ? account : null };
}

async function cacheAccessToken(db, token, expiresIn) {
  if (!token) return;
  await setSetting(db, 'zoho_access_token', token);
  // Expire a minute early so a token is never used in its final seconds.
  await setSetting(db, 'zoho_access_expires', String(Date.now() + ((expiresIn || 3600) - 60) * 1000));
}

/** A valid access token, refreshed only when the cached one has expired. */
export async function accessToken(env, db) {
  const cached = await getSetting(db, 'zoho_access_token');
  const expires = Number(await getSetting(db, 'zoho_access_expires') || 0);
  if (cached && Date.now() < expires) return { ok: true, token: cached };

  const refresh = await getSetting(db, 'zoho_refresh_token');
  if (!refresh) return { ok: false, error: 'not-connected' };

  const res = await fetch(`${region(env).accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    return { ok: false, error: data.error || `http-${res.status}` };
  }
  await cacheAccessToken(db, data.access_token, data.expires_in);
  return { ok: true, token: data.access_token };
}

// --- account ----------------------------------------------------------------

async function fetchAccount(env, token) {
  try {
    const res = await fetch(`${region(env).mail}/api/accounts`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    const first = (data?.data || [])[0];
    if (!first) return { ok: false, error: 'no-account-returned' };
    return {
      ok: true,
      accountId: String(first.accountId),
      primaryAddress: first.primaryEmailAddress || first.mailboxAddress || null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 120) };
  }
}

// --- the signature ----------------------------------------------------------

/**
 * The account's own signature, fetched from Zoho.
 *
 * Zoho does NOT attach the webmail signature to messages posted through the
 * API — that is a compose-time feature of the web client. So mail sent from
 * this dashboard arrived without the firma while mail sent by hand had it.
 * Rather than keeping a second copy of the signature in this repo (which then
 * drifts from the real one), it is read from the account that is sending.
 *
 * Cached for a day in app_settings: it changes rarely and a send must not wait
 * on an extra round trip. `force` refreshes it after an edit in Zoho.
 *
 * Uses ZohoMail.accounts.READ, which is already in ZOHO_SCOPES — no re-consent.
 */
const SIGNATURE_TTL_MS = 24 * 60 * 60 * 1000;

export async function fetchSignature(env, db, { force = false } = {}) {
  if (!force) {
    const at = Number(await getSetting(db, 'zoho_signature_at') || 0);
    if (at && Date.now() - at < SIGNATURE_TTL_MS) {
      return { ok: true, html: await getSetting(db, 'zoho_signature'), cached: true };
    }
  }

  const tok = await accessToken(env, db);
  if (!tok.ok) return { ok: false, error: `auth: ${tok.error}` };

  try {
    const res = await fetch(`${region(env).mail}/api/accounts/signature`, {
      headers: { Authorization: `Zoho-oauthtoken ${tok.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `http-${res.status}` };

    // One id returns an object, no id returns an array. `position` orders them,
    // so the lowest is the default.
    const list = Array.isArray(data?.data) ? data.data : (data?.data ? [data.data] : []);
    if (!list.length) return { ok: true, html: null, empty: true };

    const chosen = [...list].sort((a, b) => Number(a?.position ?? 0) - Number(b?.position ?? 0))[0];
    const html = String(chosen?.content || '').trim() || null;

    await setSetting(db, 'zoho_signature', html || '');
    await setSetting(db, 'zoho_signature_at', String(Date.now()));
    return { ok: true, html, name: chosen?.name || null };
  } catch (err) {
    return { ok: false, error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 120) };
  }
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Where the firma goes: above the legal footer, below the sign-off. */
const FOOTER_MARK = 'If this is not relevant';

export function splitFooter(body) {
  const i = String(body ?? '').indexOf(FOOTER_MARK);
  if (i < 0) return { message: String(body ?? ''), footer: '' };
  return { message: String(body).slice(0, i).trimEnd(), footer: String(body).slice(i).trim() };
}

/**
 * Build the HTML message: the plaintext draft rendered faithfully, the firma
 * exactly as Zoho stores it, and the legal footer set quieter but still plainly
 * readable.
 *
 * The stored draft stays plaintext — that is what the dashboard shows and what
 * gets edited. HTML is produced only at the moment of sending.
 */
export function buildHtmlBody(body, signatureHtml) {
  const { message, footer } = splitFooter(body);
  // "book a call here: <url>" becomes "here" as the anchor. The plaintext keeps
  // the bare URL, because a plaintext reader has no other way to reach it.
  const para = (t) => escapeHtml(t)
    .replace(/here:\s+(https?:\/\/[^\s<]+)/g,
      (_, url) => `<a href="${url}" style="color:#006FEE">here</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (m, pre, url) => `${pre}<a href="${url}" style="color:#006FEE">${url}</a>`)
    .replace(/\n/g, '<br>');
  return [
    '<div style="font:15px/1.65 -apple-system,BlinkMacSystemFont,\'Segoe UI\',system-ui,sans-serif;color:#1a1918">',
    `<div>${para(message)}</div>`,
    signatureHtml ? `<div style="margin-top:18px">${signatureHtml}</div>` : '',
    footer
      ? `<div style="margin-top:22px;padding-top:12px;border-top:1px solid #e0e0e0;font-size:12px;line-height:1.5;color:#666">${para(footer)}</div>`
      : '',
    '</div>',
  ].filter(Boolean).join('');
}

/** Plaintext fallback: the firma flattened, inserted above the legal footer. */
export function buildTextBody(body, signatureHtml) {
  const firma = htmlToText(signatureHtml);
  if (!firma) return body;
  const { message, footer } = splitFooter(body);
  return [message, '', firma, footer ? `\n${footer}` : ''].filter(Boolean).join('\n').trim();
}

/** Enough HTML-to-text for a signature block: links keep their URL. */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<\s*a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi,
      (_, href, text) => {
        const label = text.replace(/<[^>]+>/g, '').trim();
        const url = String(href).trim();
        if (!label) return url;
        return url.includes(label) || label.includes(url) ? label : `${label} (${url})`;
      })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// --- reading the bounce label -----------------------------------------------

/**
 * The id of a label, by name.
 *
 * Cached, because it never changes and this runs on every cron tick. A label
 * renamed in Zoho is picked up when the cache is cleared or the name setting
 * changes.
 */
export async function labelIdByName(env, db, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return { ok: false, error: 'no-label-name' };

  const cachedFor = await getSetting(db, 'zoho_bounce_label_name');
  const cachedId = await getSetting(db, 'zoho_bounce_label_id');
  if (cachedId && cachedFor === wanted) return { ok: true, id: cachedId, cached: true };

  const tok = await accessToken(env, db);
  if (!tok.ok) return { ok: false, error: `auth: ${tok.error}` };
  const accountId = await getSetting(db, 'zoho_account_id');
  if (!accountId) return { ok: false, error: 'no-account-id' };

  try {
    const res = await fetch(`${region(env).mail}/api/accounts/${accountId}/labels`, {
      headers: { Authorization: `Zoho-oauthtoken ${tok.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'scope-missing (reconnect Zoho to grant mail read access)' };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `http-${res.status}` };

    const list = Array.isArray(data?.data) ? data.data : [];
    const hit = list.find((l) => String(l?.displayName || l?.labelName || '').trim().toLowerCase() === wanted);
    if (!hit) {
      return { ok: false, error: `no label named "${name}" (found: ${list.map((l) => l.displayName || l.labelName).join(', ') || 'none'})` };
    }

    const id = String(hit.labelId ?? hit.id);
    await setSetting(db, 'zoho_bounce_label_id', id);
    await setSetting(db, 'zoho_bounce_label_name', wanted);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 120) };
  }
}

/** Recent messages carrying a label, newest first. Headers and summary only. */
export async function messagesWithLabel(env, db, labelId, { limit = 50 } = {}) {
  const tok = await accessToken(env, db);
  if (!tok.ok) return { ok: false, error: `auth: ${tok.error}` };
  const accountId = await getSetting(db, 'zoho_account_id');
  if (!accountId) return { ok: false, error: 'no-account-id' };

  const url = `${region(env).mail}/api/accounts/${accountId}/messages/view`
    + `?labelid=${encodeURIComponent(labelId)}&limit=${Math.min(Number(limit) || 50, 200)}`
    + '&sortBy=date&sortorder=false';

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${tok.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'scope-missing (reconnect Zoho to grant mail read access)' };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    return { ok: true, messages: Array.isArray(data?.data) ? data.data : [] };
  } catch (err) {
    return { ok: false, error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 120) };
  }
}

// --- sending ----------------------------------------------------------------

/**
 * Send one message.
 *
 * Returns { ok } or { ok:false, error }. Never throws: a send failure must
 * leave the draft untouched and reviewable, not lose it.
 */
export async function sendMail(env, db, { to, subject, body, fromAddress }) {
  if (!zohoConfigured(env)) return { ok: false, error: 'zoho-not-configured' };

  // Last line of defence. Subject and recipient are derived from scraped
  // pages, so a control character in either could inject a mail header. The
  // composer strips them too; this refuses regardless of how it was called.
  const cleanSubject = String(subject ?? '').replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, 200);
  const cleanTo = String(to ?? '').trim();
  if (/[\r\n\u0000,;<>]/.test(cleanTo)) return { ok: false, error: 'invalid-recipient' };
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(cleanTo)) return { ok: false, error: 'invalid-recipient' };

  const tok = await accessToken(env, db);
  if (!tok.ok) return { ok: false, error: `auth: ${tok.error}` };

  const accountId = await getSetting(db, 'zoho_account_id');
  if (!accountId) return { ok: false, error: 'no-account-id (reconnect Zoho)' };

  const from = fromAddress || env.SENDER_EMAIL || (await getSetting(db, 'zoho_from_address'));
  if (!from) return { ok: false, error: 'no-from-address' };

  // The firma, from the sending account itself. A failure here must never stop
  // a send: the email is still correct and still legal without it, so we note
  // it and carry on rather than losing the message.
  const sig = await fetchSignature(env, db);
  const signatureHtml = sig.ok ? sig.html : null;

  // Zoho's send API takes ONE content field and mailFormat is html|plaintext —
  // there is no multipart/alternative here, so this picks one. HTML is the
  // default because it is the only way the real firma renders as designed;
  // set MAIL_FORMAT=plaintext to send flattened text instead.
  const format = String(env.MAIL_FORMAT || 'html').toLowerCase() === 'plaintext' ? 'plaintext' : 'html';
  const content = format === 'html'
    ? buildHtmlBody(body, signatureHtml)
    : buildTextBody(body, signatureHtml);

  try {
    const res = await fetch(`${region(env).mail}/api/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${tok.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fromAddress: from,
        toAddress: cleanTo,
        subject: cleanSubject,
        content,
        mailFormat: format,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `http-${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
    // Zoho reports application-level failures inside a 200.
    const code = data?.status?.code;
    if (code && code !== 200) {
      return { ok: false, error: `zoho-${code}: ${String(data?.status?.description).slice(0, 150)}` };
    }
    return {
      ok: true,
      messageId: data?.data?.messageId || null,
      format,
      signature: signatureHtml ? 'attached' : (sig.ok ? 'none-set-in-zoho' : `unavailable: ${sig.error}`),
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 150),
    };
  }
}

/** How many were sent today, for the daily cap. */
export async function sentToday(db) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM outreach WHERE status = 'SENT' AND date(sent_at) = date('now')")
    .first();
  return row?.n || 0;
}
