// Cal.com — the booking calendar, shared by every profile.
//
// The emails all end with one link to a 15-minute call, and that link is the
// same whoever the profile is writing to: one person's diary cannot be split in
// two. So this is the one thing profiles deliberately share, and nothing in
// here takes a profile argument.
//
// Read-only. Bookings are made by the recipient through Cal's own page, and the
// dashboard only needs to show what is coming up — creating or cancelling a
// booking from here would be a second, worse Cal.com.

const API = 'https://api.cal.com/v2';

// Cal versions its API by date header rather than by path. Pinned, because an
// unpinned request silently gets whatever shape is current.
const VERSION = '2024-08-13';

export function calConfigured(env) {
  return Boolean(env?.CAL_API_KEY);
}

/**
 * Upcoming bookings, soonest first.
 *
 * Returns `{ ok: false, error }` rather than throwing: this renders a panel on
 * a page whose real job is the outreach queue, and Cal being down must not take
 * the dashboard with it.
 */
export async function upcomingBookings(env, { limit = 25 } = {}) {
  if (!calConfigured(env)) return { ok: false, error: 'not-configured', bookings: [] };

  const qs = new URLSearchParams({
    status: 'upcoming',
    take: String(Math.min(Math.max(Number(limit) || 25, 1), 100)),
    sortStart: 'asc',
  });

  try {
    const res = await fetch(`${API}/bookings?${qs}`, {
      headers: {
        authorization: `Bearer ${env.CAL_API_KEY}`,
        'cal-api-version': VERSION,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, error: `cal.com ${res.status}`, bookings: [] };
    }
    const payload = await res.json();
    const raw = Array.isArray(payload?.data) ? payload.data
      : (Array.isArray(payload?.data?.bookings) ? payload.data.bookings : []);
    return { ok: true, bookings: raw.map(normalise).filter((b) => b.start) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 140), bookings: [] };
  }
}

/**
 * One booking, in the few fields the panel shows.
 *
 * Cal has moved these keys around between versions, so each is read from either
 * spelling. A missing field renders as absent rather than as "undefined".
 */
function normalise(b) {
  const attendee = (Array.isArray(b?.attendees) ? b.attendees[0] : null) || {};
  return {
    uid: b?.uid || b?.id || null,
    title: b?.title || b?.eventType?.title || 'Call',
    start: b?.start || b?.startTime || null,
    end: b?.end || b?.endTime || null,
    status: String(b?.status || '').toLowerCase() || 'accepted',
    name: attendee.name || b?.responses?.name || null,
    email: (attendee.email || b?.responses?.email || '').toLowerCase() || null,
    location: b?.meetingUrl || b?.location || null,
  };
}
