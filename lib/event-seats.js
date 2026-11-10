// lib/event-seats.js
// Seat limits for CPD events registered on this website.
//
//   seat_limit      number of seats (null: no limit)
//   seat_hard_stop  close registration automatically once the seats are taken
//   seats_closed    set when that happened; the admin reopens it ("Add seats")
//   seat_alerts     the alert levels (80, 95, 100 %) already emailed to the secretary
//
// Pending and confirmed registrations take a seat; rejected ones don't. A seat
// freed by a rejection doesn't reopen a closed event by itself: the admin decides.

const SEAT_ALERTS = [80, 95, 100];

const usesSeats = (event) => event.category === 'cpd' && (event.registration_mode || 'online') === 'online' && Number(event.seat_limit) > 0;

async function seatsTaken(client, eventId) {
  return (await client.query("SELECT count(*)::int AS n FROM event_registrations WHERE event_id = $1 AND status <> 'rejected'", [eventId])).rows[0].n;
}

// Alert levels reached by `taken` of `limit` seats.
const levelsReached = (taken, limit) => SEAT_ALERTS.filter((level) => taken * 100 >= level * limit);

// Brings an event's seat state up to date. Call inside a transaction with the
// event row locked (SELECT ... FOR UPDATE).
//   afterRegistration: true after a new registration: new alert levels are
//     returned for emailing, and a hard stop closes registration.
//   false after an admin change (edit, add seats): levels already reached are
//     marked as done (no email), and a closed event reopens if seats are free.
// Returns { taken, alert (highest new level or null), closedNow, event }.
async function syncSeats(client, event, { afterRegistration = false } = {}) {
  let alerts = [];
  let closed = false;
  let alert = null;
  let closedNow = false;
  let taken = 0;
  if (usesSeats(event)) {
    const limit = Number(event.seat_limit);
    taken = await seatsTaken(client, event.id);
    const reached = levelsReached(taken, limit);
    const sent = (event.seat_alerts || []).filter((level) => reached.includes(level));
    const fresh = reached.filter((level) => !sent.includes(level));
    alerts = reached;
    if (afterRegistration && fresh.length) alert = Math.max(...fresh);
    const full = taken >= limit;
    if (event.seat_hard_stop) {
      closed = afterRegistration ? Boolean(event.seats_closed) || full : full;
      closedNow = afterRegistration && closed && !event.seats_closed;
    }
  }
  const updated = (await client.query(
    'UPDATE events SET seat_alerts = $1, seats_closed = $2 WHERE id = $3 RETURNING *',
    [alerts, closed, event.id]
  )).rows[0];
  return { taken, alert, closedNow, event: updated };
}

module.exports = { SEAT_ALERTS, usesSeats, seatsTaken, syncSeats };
