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

// Only what is needed: read the account list once, and send. No mailbox reads,
// no folder access, nothing that could touch existing mail.
export const ZOHO_SCOPES = 'ZohoMail.accounts.READ,ZohoMail.messages.CREATE';

function region(env) {
  return REGIONS[(env.ZOHO_REGION || 'com').toLowerCase()] || REGIONS.com;
}

export function zohoConfigured(env) {
  return Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET);
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

// --- sending ----------------------------------------------------------------

/**
 * Send one message.
 *
 * Returns { ok } or { ok:false, error }. Never throws: a send failure must
 * leave the draft untouched and reviewable, not lose it.
 */
export async function sendMail(env, db, { to, subject, body, fromAddress }) {
  if (!zohoConfigured(env)) return { ok: false, error: 'zoho-not-configured' };

  const tok = await accessToken(env, db);
  if (!tok.ok) return { ok: false, error: `auth: ${tok.error}` };

  const accountId = await getSetting(db, 'zoho_account_id');
  if (!accountId) return { ok: false, error: 'no-account-id (reconnect Zoho)' };

  const from = fromAddress || env.SENDER_EMAIL || (await getSetting(db, 'zoho_from_address'));
  if (!from) return { ok: false, error: 'no-from-address' };

  try {
    const res = await fetch(`${region(env).mail}/api/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${tok.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fromAddress: from,
        toAddress: to,
        subject,
        content: body,
        mailFormat: 'plaintext',
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
    return { ok: true, messageId: data?.data?.messageId || null };
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
