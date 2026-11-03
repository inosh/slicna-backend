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
  const rows = (await client.query("SELECT key, value FROM site_settings WHERE key LIKE 'bank_%' OR key LIKE 'membership_%'")).rows;
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

// Next free serial for a category (serials continue across years).
async function suggestMembershipNumber(category, joinedOn = today(), client = pool) {
  const rows = (await client.query('SELECT membership_number FROM members WHERE category = $1', [category])).rows;
  const max = rows.reduce((m, r) => {
    const match = /^[A-Z]{2}\s*(\d+)/.exec(r.membership_number.toUpperCase());
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return formatMembershipNumber(category, max + 1, joinedOn);
}

// "lt 0012 / 26", "LT0012/26" and "LT 0012/26" all compare equal.
function compactNumber(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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

// Last four digits, ignoring the V/X letter of old-format NICs.
function nicLast4(value) {
  return normaliseNic(value).replace(/\D/g, '').slice(-4);
}

// ---------- Renewal tokens ----------

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Creates a renewal link token for a member; only its hash is stored.
async function createRenewalToken(memberId, validDays = 90, client = pool) {
  const token = crypto.randomBytes(32).toString('base64url');
  await client.query(
    `INSERT INTO renewal_tokens (member_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [memberId, hashToken(token), String(validDays)]
  );
  return token;
}

async function memberForToken(token, client = pool) {
  if (!token || String(token).length < 20) return null;
  const row = (await client.query(
    `SELECT m.* FROM renewal_tokens t JOIN members m ON m.id = t.member_id
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
  CATEGORIES, CATEGORY_KEYS, STATE_LABELS,
  today, addDays, addYear, daysBetween,
  loadSettings, loadFees,
  memberState, renewedValidUntil,
  formatMembershipNumber, suggestMembershipNumber, compactNumber,
  TITLES, MARITAL_STATUSES, checkPhone,
  normaliseNic, isValidNic, nicLast4,
  createRenewalToken, memberForToken, renewalUrl, paymentReference,
};
