// lib/membership.js
// Membership rules shared by the public and admin routes and the reminder job:
// categories, dates, a member's current state, membership numbers, NIC checks
// and renewal tokens.

const crypto = require('crypto');
const pool = require('../db/pool');

const CATEGORIES = {
  LT: 'Lifetime Membership',
  GM: 'General Membership',
  OM: 'Ordinary Membership',
  PM: 'Partial Membership',
};
const CATEGORY_KEYS = Object.keys(CATEGORIES);

// Upgrades open to each category. Upgrading gives a number in the new
// category's series (the old one stays reserved); GM and OM then run for 12
// months like a renewal, Lifetime never expires.
const UPGRADES = { GM: ['LT'], OM: ['GM', 'LT'], PM: ['OM', 'GM', 'LT'], LT: [] };

// Valid until after an upgrade to `toCategory`: same dates as a renewal, or none for Lifetime.
function upgradedValidUntil(member, toCategory, settings, on = today()) {
  return toCategory === 'LT' ? null : renewedValidUntil(member, settings, on);
}

const STATE_LABELS = {
  active: 'Active',
  renewal_due: 'Renewal due',
  grace: 'Grace period',
  lapsed: 'Lapsed',
  deactivated: 'Deactivated',
};

// ---------- Dates (all as "YYYY-MM-DD" strings, Sri Lanka time) ----------

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const toUtc = (dateStr) => new Date(dateStr + 'T00:00:00Z');
const fromUtc = (d) => d.toISOString().slice(0, 10);

function addDays(dateStr, days) {
  const d = toUtc(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

// One year later; 29 Feb becomes 28 Feb in a non-leap year.
function addYear(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function daysBetween(fromStr, toStr) {
  return Math.round((toUtc(toStr) - toUtc(fromStr)) / 86400000);
}

// ---------- Settings ----------

async function loadSettings(client = pool) {
  const rows = (await client.query("SELECT key, value FROM site_settings WHERE key LIKE 'bank_%' OR key LIKE 'event_bank_%' OR key LIKE 'membership_%'")).rows;
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    graceDays: Number(s.membership_grace_days) || 30,
    noticeDays: Number(s.membership_notice_days) || 30,
    bank: {
      bank_name: s.bank_name || '',
      account_number: s.bank_account_number || '',
      branch: s.bank_branch || '',
      account_name: s.bank_account_name || '',
    },
    // Paid CPD events: the Educational Committee's account.
    eventBank: {
      bank_name: s.event_bank_name || '',
      account_number: s.event_bank_account_number || '',
      branch: s.event_bank_branch || '',
      account_name: s.event_bank_account_name || '',
    },
  };
}

async function loadFees(client = pool) {
  const rows = (await client.query('SELECT category, label, amount, is_annual FROM membership_fees ORDER BY display_order')).rows;
  return Object.fromEntries(rows.map((r) => [r.category, r]));
}

// ---------- Member state ----------

// active | renewal_due | grace | lapsed | deactivated, worked out from the
// dates so that lapsing needs no scheduled job.
function memberState(member, settings, on = today()) {
  if (!member.is_active) return 'deactivated';
  if (member.category === 'LT' || !member.valid_until) return 'active';
  if (on <= member.valid_until) {
    return daysBetween(on, member.valid_until) <= settings.noticeDays ? 'renewal_due' : 'active';
  }
  return on <= addDays(member.valid_until, settings.graceDays) ? 'grace' : 'lapsed';
}

// Validity after a renewal is verified on `on`: renewing before the end of the
// grace period continues from the old expiry date (no lost or free days);
// renewing after lapsing starts a fresh year from that day.
function renewedValidUntil(member, settings, on = today()) {
  const graceEnd = addDays(member.valid_until, settings.graceDays);
  return on <= graceEnd ? addYear(member.valid_until) : addYear(on);
}

// ---------- Membership numbers: "GM 0012/26" ----------

function formatMembershipNumber(category, serial, joinedOn) {
  return `${category} ${String(serial).padStart(4, '0')}/${String(joinedOn).slice(2, 4)}`;
}

// Next free serial for the category; serials continue across years. Numbers
// retired on an upgrade count as used, so they are never handed out again.
async function suggestMembershipNumber(category, joinedOn = today(), client = pool) {
  const rows = (await client.query(
    `SELECT membership_number FROM members WHERE category = $1
     UNION ALL SELECT membership_number FROM retired_membership_numbers WHERE upper(membership_number) LIKE $1 || '%'`,
    [category]
  )).rows;
  const max = rows.reduce((m, r) => {
    const match = /^[A-Z]{2}\s*(\d+)/.exec(r.membership_number.toUpperCase());
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return formatMembershipNumber(category, max + 1, joinedOn);
}

// A typed membership number -> { category, serial: "GM 0012", number: "GM 0012/26" }, or null.
// Accepts "gm 12/26", "GM0012/26", "GM 0012 / 26" (category, serial, 2-digit year).
// The year may be left out ("GM 12"): number is then null.
// "GM 0012/25", "GM 12", and the old card style "GM/012/2025" or "GM-012-25".
function parseMembershipNumber(value) {
  const m = /^(LT|GM|OM|PM)\s*[/-]?\s*0*(\d{1,4})\s*(?:[/-]\s*(\d{4}|\d{2}))?$/.exec(String(value || '').trim().toUpperCase());
  if (!m) return null;
  const serial = `${m[1]} ${m[2].padStart(4, '0')}`;
  const year = m[3] ? m[3].slice(-2) : null;
  return { category: m[1], serial, number: year ? `${serial}/${year}` : null };
}

// "lt 0012 / 26", "LT0012/26" and "LT 0012/26" all compare equal.
function compactNumber(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// The member with this membership number, or null. The year may be left out
// ("GM 0003") when only one member has that number; if several do, a 400
// error asks for it.
async function findMemberByNumber(value, client = pool) {
  const compact = "regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g')";
  const exact = compactNumber(value);
  if (!exact) return null;
  const member = (await client.query(`SELECT * FROM members WHERE ${compact} = $1`, [exact])).rows[0];
  const parsed = parseMembershipNumber(value);
  if (member || !parsed) return member || null;
  // Typed another way ("GM/001/2023"): look up the standard form.
  if (parsed.number) return (await client.query(`SELECT * FROM members WHERE ${compact} = $1`, [compactNumber(parsed.number)])).rows[0] || null;
  const found = (await client.query(
    `SELECT * FROM members WHERE ${compact} ~ $1 LIMIT 2`, [`^${compactNumber(parsed.serial)}[0-9]{2}$`]
  )).rows;
  if (found.length > 1) {
    const err = new Error(`More than one member has ${parsed.serial}. Please add the year from your membership card, for example ${parsed.serial}/25.`);
    err.statusCode = 400;
    throw err;
  }
  return found[0] || null;
}

// ---------- Form values shared with SLNA's join form ----------

const TITLES = ['Prof.', 'Dr.', 'Mr.', 'Miss.', 'Mrs.'];
const MARITAL_STATUSES = ['Single', 'Married', 'Other'];

// ---------- Phone numbers (same rules as SLNA's join form) ----------
// Mobile: 07[0-8] + 7 digits. Other numbers: any Sri Lankan 10-digit number.
// Both accept 0XXXXXXXXX or +94XXXXXXXXX; spaces and dashes are ignored.

const PHONE_RULES = {
  mobile: { re: /^(?:\+94|0)7[0-8][0-9]{7}$/, hint: '07XXXXXXXX or +947XXXXXXXX' },
  phone: { re: /^(?:\+94|0)[1-9][0-9]{8}$/, hint: '0XXXXXXXXX or +94XXXXXXXXX' },
};

// Returns the cleaned number (or null when empty); throws a 400 if invalid.
function checkPhone(value, kind, label) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/[\s-]/g, '');
  if (!PHONE_RULES[kind].re.test(cleaned)) {
    const err = new Error(`${label} must be a valid Sri Lankan number (${PHONE_RULES[kind].hint}).`);
    err.statusCode = 400;
    throw err;
  }
  return cleaned;
}

// ---------- NIC ----------

function normaliseNic(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '');
}

function isValidNic(value) {
  return /^(\d{9}[VX]|\d{12})$/.test(normaliseNic(value));
}

// Both forms of a NIC number. An old NIC (YYDDDSSSC + V/X, e.g. 852220172V)
// has a fixed new 12-digit equivalent: 19 + YYDDD + 0 + SSSC (198522200172),
// so a member can type either and still match.
function nicVariants(value) {
  const nic = normaliseNic(value);
  const old = /^(\d{5})(\d{4})[VX]$/.exec(nic);
  if (old) return [nic, `19${old[1]}0${old[2]}`];
  const modern = /^(19\d{5})0(\d{4})$/.exec(nic);
  if (modern) return [nic, `${modern[1].slice(2)}${modern[2]}V`, `${modern[1].slice(2)}${modern[2]}X`];
  return [nic];
}

const nicMatches = (a, b) => nicVariants(a).includes(normaliseNic(b));

// ---------- Renewal tokens ----------

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Creates a renewal link token for a member; only its hash is stored.
// viaLookup: made from a membership number typed on the renewal page (see schema).
async function createRenewalToken(memberId, validDays = 90, client = pool, { viaLookup = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await client.query(
    `INSERT INTO renewal_tokens (member_id, token_hash, expires_at, via_lookup) VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [memberId, hashToken(token), String(validDays), viaLookup]
  );
  return token;
}

// The member, plus via_lookup from the token.
async function memberForToken(token, client = pool) {
  if (!token || String(token).length < 20) return null;
  const row = (await client.query(
    `SELECT m.*, t.via_lookup FROM renewal_tokens t JOIN members m ON m.id = t.member_id
     WHERE t.token_hash = $1 AND t.expires_at > now()`,
    [hashToken(token)]
  )).rows[0];
  return row || null;
}

function renewalUrl(token) {
  const site = (process.env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${site}/pages/membership-renew.html?t=${encodeURIComponent(token)}`;
}

function paymentReference(member, on = today()) {
  return `${compactNumber(member.membership_number)}-${on.slice(2, 4)}${on.slice(5, 7)}`;
}

module.exports = {
  CATEGORIES, CATEGORY_KEYS, STATE_LABELS, UPGRADES,
  today, addDays, addYear, daysBetween,
  loadSettings, loadFees,
  memberState, renewedValidUntil, upgradedValidUntil,
  formatMembershipNumber, suggestMembershipNumber, compactNumber, parseMembershipNumber, findMemberByNumber,
  TITLES, MARITAL_STATUSES, checkPhone,
  normaliseNic, isValidNic, nicVariants, nicMatches,
  createRenewalToken, memberForToken, renewalUrl, paymentReference,
};
