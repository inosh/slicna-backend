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
// members-only event).
function feeFor(event, feeCategory) {
  if (event.category !== 'cpd') return 0;
  if (feeCategory === 'NM' && event.audience === 'members') return null;
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

const isPast = (event, today) => String(event.end_date || event.event_date).slice(0, 10) < today;

// Registration is possible for upcoming CPD events whose status is "open".
function registrationOpen(event, today) {
  return event.category === 'cpd' && event.status === 'open' && !isPast(event, today);
}

// The public view of an event.
function publicEvent(event, today) {
  const past = isPast(event, today);
  return {
    id: event.id,
    title: event.title,
    category: event.category,
    category_label: KINDS[event.category],
    event_type: event.event_type,
    status: event.status,
    status_label: past ? 'Completed' : (STATUSES[event.category] || {})[event.status] || '',
    is_past: past,
    registration_open: registrationOpen(event, today),
    event_date: event.event_date,
    end_date: event.end_date,
    time_text: event.time_text,
    location: event.location,
    summary: event.summary,
    body: event.body,
    cpd_points: event.cpd_points,
    audience: event.category === 'cpd' ? event.audience : null,
    audience_label: event.category === 'cpd' ? AUDIENCES[event.audience] : null,
    fee_type: event.category === 'cpd' ? event.fee_type : null,
    fees: feeSummary(event),
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
  feeFor, feeSummary, isPast, registrationOpen, publicEvent,
};
