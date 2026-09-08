// Can this domain receive mail at all?
//
// Asked before a lead reaches the review queue, so a dead address is never put
// in front of the reviewer and never costs a send. Six addresses in the bounce
// log were on domains that simply do not exist — antik.brooklyn, ivity.get,
// checkout.duties — and every one of those bounces was avoidable by asking a
// DNS server first.
//
// This is a DNS lookup and nothing else. No message is sent, no SMTP session is
// opened, the recipient's server is never contacted and the business never
// learns anything happened. Probing a mailbox by starting an SMTP conversation
// (RCPT TO and hang up) would tell us more and is exactly the rude, spam-shaped
// behaviour this project avoids.
//
// Workers has no dns module, so this uses DNS-over-HTTPS against 1.1.1.1.

const DOH = 'https://cloudflare-dns.com/dns-query';

// A domain that resolves rarely stops. A domain that does not exist may be
// registered tomorrow, so a negative answer is trusted for less time.
const TTL_LIVE_DAYS = 30;
const TTL_DEAD_DAYS = 7;

async function query(name, type) {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`doh-http-${res.status}`);
  return res.json();
}

/**
 * Resolve deliverability, ignoring any cache.
 *
 * Returns { deliverable, detail }. RFC 5321: a domain with no MX record but a
 * usable address record still accepts mail, so both are checked before calling
 * a domain dead.
 */
export async function lookupMx(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!d || !d.includes('.') || /\s/.test(d)) return { deliverable: false, detail: 'malformed-domain' };

  const mx = await query(d, 'MX');

  // NXDOMAIN is the definitive answer: nothing is registered here.
  if (mx.Status === 3) return { deliverable: false, detail: 'nxdomain' };
  if (mx.Status !== 0) return { deliverable: false, detail: `dns-status-${mx.Status}` };

  const mxRecords = (mx.Answer || []).filter((a) => a.type === 15);
  if (mxRecords.length) return { deliverable: true, detail: `mx:${mxRecords.length}` };

  // No MX. An A or AAAA record still implies a mail exchanger.
  const a = await query(d, 'A');
  if (a.Status === 0 && (a.Answer || []).some((x) => x.type === 1)) {
    return { deliverable: true, detail: 'implicit-mx:a' };
  }
  const aaaa = await query(d, 'AAAA');
  if (aaaa.Status === 0 && (aaaa.Answer || []).some((x) => x.type === 28)) {
    return { deliverable: true, detail: 'implicit-mx:aaaa' };
  }
  return { deliverable: false, detail: 'no-mx-no-address' };
}

/** The domain, but only from something shaped like a real address. */
function domainOf(email) {
  const parts = String(email || '').trim().split('@');
  // Exactly one @, and something on both sides of it. "@b.com" names a real
  // domain but is not an address anyone can be reached at.
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return parts[1].trim().toLowerCase() || null;
}

/**
 * The cached question: can we send to this address?
 *
 * Fails OPEN. If DNS itself is unreachable the answer is "assume yes" and
 * nothing is cached — a network blip must not silently empty the morning queue,
 * and a wrong "yes" costs one bounce while a wrong "no" costs every lead.
 */
export async function canReceiveMail(db, email) {
  const domain = domainOf(email);
  if (!domain) return { deliverable: false, detail: 'no-domain', cached: false };

  const row = await db
    .prepare('SELECT deliverable, detail, checked_at FROM mx_cache WHERE domain = ?')
    .bind(domain).first();

  if (row) {
    const ttl = (row.deliverable ? TTL_LIVE_DAYS : TTL_DEAD_DAYS) * 86400_000;
    if (Date.now() - Date.parse(row.checked_at) < ttl) {
      return { deliverable: Boolean(row.deliverable), detail: row.detail, cached: true };
    }
  }

  let result;
  try {
    result = await lookupMx(domain);
  } catch (err) {
    return { deliverable: true, detail: `lookup-failed: ${String(err?.message || err).slice(0, 60)}`, cached: false };
  }

  await db.prepare(
    `INSERT INTO mx_cache (domain, deliverable, detail, checked_at) VALUES (?,?,?,?)
     ON CONFLICT(domain) DO UPDATE SET
       deliverable = excluded.deliverable, detail = excluded.detail, checked_at = excluded.checked_at`
  ).bind(domain, result.deliverable ? 1 : 0, result.detail, new Date().toISOString()).run();

  return { ...result, cached: false };
}
