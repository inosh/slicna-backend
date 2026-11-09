// lib/events.js
// Event kinds, types, statuses and the fee rules shared by the public event
// pages, registration and the admin panel.

const { CATEGORIES } = require('./membership');

const KINDS = { cpd: 'CPD event', other: 'Other event' };

const EVENT_TYPES = {
  cpd: ['Workshop', 'Training', 'Webinar', 'Seminar', 'Study Day', 'Conference', 'Educational Programme', 'Certificate Programme', 'International Workshop', 'Other'],
  other: ['Annual General Meeting', 'General Meeting', 'Community Event', 'Awareness Programme', 'Celebration', 'Other Event'],
};

const STATUSES = {
  cpd: { coming_soon: 'Programme Announced Soon', opening_soon: 'Registration Opening Soon', open: 'Registration Open', closed: 'Registration Closed' },
  other: { coming_soon: 'Details Coming Soon', upcoming: 'Upcoming' },
};

const AUDIENCES = { public: 'Open to everyone', members: 'SLICNA members only' };
const MEMBER_CATEGORY_KEYS = ['LT', 'GM', 'OM', 'PM'];
const FEE_COLUMNS = { LT: 'fee_lt', GM: 'fee_gm', OM: 'fee_om', PM: 'fee_pm' };

// Members whose membership is in one of these states pay the member fee.
const MEMBER_STATES_WITH_BENEFITS = ['active', 'renewal_due', 'grace'];

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// The fee for one registrant: a member category (LT/GM/OM/PM) or 'NM'.
// Returns null when that registrant can't register (non-members at a
// members-only event). FO / FP: foreign participants online / physical, in USD.
function feeFor(event, feeCategory) {
  if (event.category !== 'cpd') return 0;
  if (feeCategory === 'NM' && event.audience === 'members') return null;
  if (feeCategory === 'FO' || feeCategory === 'FP') {
    const online = feeCategory === 'FO';
    if (event.audience === 'members' || !event[online ? 'foreign_online' : 'foreign_physical']) return null;
    return event.fee_type === 'paid' ? num(event[online ? 'foreign_fee_online' : 'foreign_fee_physical']) || 0 : 0;
  }
  if (event.fee_type !== 'paid') return 0;
  if (feeCategory === 'NM') return num(event.non_member_fee) || 0;
  if (event.member_pricing === 'by_category') return num(event[FEE_COLUMNS[feeCategory]]) || 0;
  return num(event.member_fee) || 0;
}

// What the public pages show: one line per distinct price, e.g.
//   [{ label: 'Members', amount: 1000 }, { label: 'Non-members', amount: 2500 }]
//   [{ label: 'Lifetime & General members', amount: 500 }, ...]
// Same-priced member categories are grouped; free events return [].
function feeSummary(event) {
  if (event.category !== 'cpd' || event.fee_type !== 'paid') return [];
  const lines = [];
  if (event.member_pricing === 'by_category') {
    const groups = new Map();
    MEMBER_CATEGORY_KEYS.forEach((c) => {
      const amount = feeFor(event, c);
      if (!groups.has(amount)) groups.set(amount, []);
      groups.get(amount).push(c);
    });
    if (groups.size === 1) {
      lines.push({ label: 'Members', amount: [...groups.keys()][0] });
    } else {
      groups.forEach((cats, amount) => {
        const names = cats.map((c) => CATEGORIES[c].replace(' Membership', ''));
        const label = names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]} members` : `${names[0]} members`;
        lines.push({ label, amount, categories: cats });
      });
    }
  } else {
    lines.push({ label: 'Members', amount: feeFor(event, 'GM') });
  }
  if (event.audience !== 'members') {
    const nm = feeFor(event, 'NM');
    // Everyone pays the same: one "Everyone" line instead of two equal ones.
    if (lines.length === 1 && lines[0].amount === nm) return [{ label: 'Everyone', amount: nm }];
    lines.push({ label: 'Non-members', amount: nm });
  }
  return lines;
}

// Foreign participants: the ways they can attend and the fee for each, e.g.
//   [{ category: 'FO', mode: 'online', label: 'Online', amount: 10, currency: 'USD' }, ...]
// Empty when the event isn't open to them.
function foreignOptions(event) {
  if (event.category !== 'cpd' || event.audience === 'members') return [];
  return [['FO', 'online', 'Online'], ['FP', 'physical', 'Physical']]
    .filter(([c]) => feeFor(event, c) !== null)
    .map(([c, mode, label]) => ({ category: c, mode, label, amount: feeFor(event, c), currency: 'USD' }));
}

const DURATION_UNITS = { day: 'Day(s)', month: 'Month(s)', year: 'Year(s)' };
const ymd = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

// The event's last day: its exact end date if one is set, otherwise the start
// date plus the duration, minus a day (3 days from 1 Dec ends on 3 Dec). Null
// for a one-day event.
function endDateOf(event) {
  const start = ymd(event.event_date);
  if (event.end_date) return ymd(event.end_date);
  const n = Number(event.duration_number) > 0 ? Number(event.duration_number) : 1;
  const d = new Date(start + 'T00:00:00Z');
  if (event.duration_unit === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  else if (event.duration_unit === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
  else d.setUTCDate(d.getUTCDate() + n);
  d.setUTCDate(d.getUTCDate() - 1);
  const end = d.toISOString().slice(0, 10);
  return end > start ? end : null;
}

// "3 days", "2 months", "1 year"; null for one day.
function durationText(event) {
  const n = Number(event.duration_number) || 1;
  const unit = event.duration_unit || 'day';
  if (event.end_date || (n === 1 && unit === 'day')) return null;
  return `${n} ${unit}${n > 1 ? 's' : ''}`;
}

const isPast = (event, today) => (endDateOf(event) || ymd(event.event_date)) < today;

// A multi-day event that has started and not yet ended (shown as "Ongoing").
function isOngoing(event, today) {
  const end = endDateOf(event);
  return Boolean(end) && ymd(event.event_date) <= today && today <= end;
}

// Registration on this website: upcoming CPD events registered here ("online")
// whose status is "open".
// Closed while all seats are taken and the hard stop closed it (seats_closed).
function registrationOpen(event, today) {
  return event.category === 'cpd' && (event.registration_mode || 'online') === 'online' && event.status === 'open' && !event.seats_closed && !isPast(event, today);
}

// "8.00 a.m." from a time column ("08:00:00").
function formatTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}.${m[2]} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

// The time shown to visitors: the free text if one was typed, otherwise
// "8.00 a.m. – 4.00 p.m." from the start and end times.
function timeText(event) {
  if (event.time_text) return event.time_text;
  const start = formatTime(event.start_time);
  const end = formatTime(event.end_time);
  return start && end ? `${start} – ${end}` : start || '';
}

// The public view of an event.
function publicEvent(event, today) {
  const past = isPast(event, today);
  // All seats taken and registration closed automatically: shown as closed, with a note.
  const seatsFull = event.category === 'cpd' && Boolean(event.seats_closed) && event.status === 'open' && !past;
  return {
    id: event.id,
    title: event.title,
    category: event.category,
    category_label: KINDS[event.category],
    event_type: event.event_type,
    status: seatsFull ? 'closed' : event.status,
    seats_full: seatsFull,
    status_label: past ? 'Completed'
      : seatsFull ? STATUSES.cpd.closed
      : event.category === 'cpd' && event.registration_mode === 'none' ? 'No registration needed'
        : (STATUSES[event.category] || {})[event.status] || '',
    is_past: past,
    is_ongoing: isOngoing(event, today),
    registration_open: registrationOpen(event, today),
    event_date: event.event_date,
    // The last day (from the duration or the exact end date); null for one day.
    end_date: endDateOf(event),
    duration_text: durationText(event),
    time_text: timeText(event),
    registration_mode: event.category === 'cpd' ? event.registration_mode || 'online' : null,
    registration_url: event.category === 'cpd' && event.registration_mode === 'external' ? event.registration_url : null,
    // The meeting link is public only for events that need no registration.
    join_url: event.category === 'cpd' && event.registration_mode === 'none' && !past ? event.join_url : null,
    location: event.location,
    summary: event.summary,
    body: event.body,
    cpd_points: event.cpd_points,
    audience: event.category === 'cpd' ? event.audience : null,
    audience_label: event.category === 'cpd' ? AUDIENCES[event.audience] : null,
    fee_type: event.category === 'cpd' ? event.fee_type : null,
    fees: feeSummary(event),
    // Foreign participants (online / physical, in USD); empty when not open to them.
    foreign: foreignOptions(event),
    // Fee per registrant: LT/GM/OM/PM members and NM (null: non-members can't register).
    fee_by_category: event.category === 'cpd'
      ? Object.fromEntries([...MEMBER_CATEGORY_KEYS, 'NM'].map((c) => [c, feeFor(event, c)]))
      : null,
    photo_url: event.photo_url,
    attachment_url: event.attachment_url,
    attachment_name: event.attachment_name,
  };
}

module.exports = {
  KINDS, EVENT_TYPES, STATUSES, AUDIENCES, MEMBER_CATEGORY_KEYS, FEE_COLUMNS, MEMBER_STATES_WITH_BENEFITS,
  DURATION_UNITS, endDateOf, durationText, isOngoing, timeText,
  feeFor, feeSummary, foreignOptions, isPast, registrationOpen, publicEvent,
};
