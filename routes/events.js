// routes/events.js
// Public event endpoints (no login):
//   GET  /api/events                         all events (CPD and other), oldest first
//   GET  /api/events/:id                     one event, with bank details for paid events
//   POST /api/events/:id/member-check        membership number -> the member's category and fee
//   POST /api/events/:id/registrations       register for a CPD event (multipart, receipt)
// Adding and editing events is in routes/events-admin.js.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const M = require('../lib/membership');
const E = require('../lib/events');
const { parseFields, parseId, validationError } = require('../lib/crud');
const { privateUpload, uploadedKey, discardUploads } = require('../lib/private-files');
const { sendMailInBackground } = require('../lib/mail');
const emails = require('../lib/event-emails');
const { syncSeats, usesSeats, seatsTaken } = require('../lib/event-seats');

const SEATS_FULL = 'All seats for this event have been filled, so registration is closed for now.';

const router = express.Router();

const limiter = (max, minutes, message, extra = {}) => rateLimit({
  windowMs: minutes * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: message }, ...extra,
});
const registerLimiter = limiter(10, 60, 'Too many registrations from this device. Please try again later.', { skipFailedRequests: true });
const lookupLimiter = limiter(20, 15, 'Too many attempts. Please wait 15 minutes and try again.');

const getEvent = async (id) => (id ? (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0] : null);

router.get('/', async (req, res, next) => {
  try {
    const today = M.today();
    const rows = (await pool.query('SELECT * FROM events ORDER BY event_date ASC, id ASC')).rows;
    res.json(rows.map((e) => E.publicEvent(e, today)));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const event = await getEvent(parseId(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    const result = E.publicEvent(event, M.today());
    if (result.fees.some((f) => f.amount > 0)) result.bank = (await M.loadSettings()).eventBank;
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------- Members ----------

// Members are found by membership number alone (M.findMemberByNumber): older
// records have no NIC, and some members aren't in the register yet. The year
// may be left out when only one member has that number.
const NUMBER_FORMAT = 'Please enter your membership number like GM 0012/25 (LT, GM, OM or PM and the number; the year is optional).';
// A number not in the register is accepted at its category's fee, but then the year is needed to record it.
const needYear = (parsed) => `We couldn't find ${parsed.serial} in our register. Please add the year from your membership card, for example ${parsed.serial}/25.`;

// What a member pays for this event, or why they can't use the member rate.
async function memberQuote(event, member) {
  const state = M.memberState(member, await M.loadSettings());
  const eligible = E.MEMBER_STATES_WITH_BENEFITS.includes(state);
  const nonMembersAllowed = event.audience !== 'members';
  let message = '';
  if (state === 'lapsed') {
    message = `Your membership expired on ${member.valid_until}. Please renew it to register at the member rate${nonMembersAllowed ? ', or register as a non-member' : ''}.`;
  } else if (state === 'deactivated') {
    message = `This membership is not active. Please contact SLICNA${nonMembersAllowed ? ', or register as a non-member' : ''}.`;
  }
  return {
    found: true,
    eligible,
    state,
    message,
    membership_number: member.membership_number,
    category: member.category,
    category_label: M.CATEGORIES[member.category],
    fee: eligible ? E.feeFor(event, member.category) : null,
  };
}

router.post('/:id/member-check', lookupLimiter, async (req, res, next) => {
  try {
    const event = await getEvent(parseId(req.params.id));
    if (!event || event.category !== 'cpd') return res.status(404).json({ error: 'Event not found.' });
    const parsed = M.parseMembershipNumber(req.body.membership_number);
    if (!parsed) return res.status(400).json({ error: NUMBER_FORMAT });
    const member = await M.findMemberByNumber(req.body.membership_number);
    if (member) return res.json(await memberQuote(event, member));
    if (!parsed.number) return res.status(400).json({ error: needYear(parsed) });
    // Not in the register (yet): the prefix gives the category and the fee; SLICNA checks it later.
    res.json({
      found: false,
      eligible: true,
      membership_number: parsed.number,
      category: parsed.category,
      category_label: M.CATEGORIES[parsed.category],
      fee: E.feeFor(event, parsed.category),
      message: 'We could not find this number in our online register yet (older records are still being added). You can still register; SLICNA will check your membership.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Registration ----------

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newReference = () => 'REG-' + [...crypto.randomBytes(8)].map((b) => REF_CHARS[b % REF_CHARS.length]).join('');

const REGISTRATION_FIELDS = {
  full_name: { type: 'text', label: 'Full name', required: true, max: 255 },
  certificate_name: { type: 'text', label: 'Name on the certificate', required: true, max: 255 },
  nic_number: { type: 'text', label: 'NIC number', required: true, max: 20 },
  slnc_number: { type: 'text', label: 'SLNC registration number', max: 50 },
  country: { type: 'text', label: 'Country', max: 100 },
  email: { type: 'text', label: 'Email', required: true, max: 255 },
  mobile: { type: 'text', label: 'Mobile number', required: true, max: 30 },
  postal_address: { type: 'text', label: 'Postal address', required: true, max: 500 },
  workplace: { type: 'text', label: 'Workplace', required: true, max: 255 },
  workplace_address: { type: 'text', label: 'Workplace address', required: true, max: 500 },
};
const PAYMENT_FIELDS = {
  pay_by: { type: 'enum', label: 'Paid by', required: true, values: ['individual', 'organisation'] },
  payment_date: { type: 'date', label: 'Payment date', required: true },
};

// Receipts go to events/<event id>/registrations/<reference>/.
function assignReference(req, res, next) {
  req.registrationReference = newReference();
  next();
}

router.post(
  '/:id/registrations',
  registerLimiter,
  assignReference,
  privateUpload((req) => `events/${parseId(req.params.id) || 'unknown'}/registrations/${req.registrationReference}`, { receipt: 'document' }),
  async (req, res, next) => {
    try {
      const event = await getEvent(parseId(req.params.id));
      if (!event || event.category !== 'cpd') throw Object.assign(new Error('Event not found.'), { statusCode: 404 });
      if (!E.registrationOpen(event, M.today())) throw validationError(event.seats_closed ? SEATS_FULL : 'Registration for this event is not open.');

      const values = parseFields(req.body, REGISTRATION_FIELDS);
      const foreign = req.body.registrant_type === 'foreign';
      values.nic_number = M.normaliseNic(values.nic_number);
      if (foreign) {
        // Foreign participants: passport number (in nic_number), country and an international mobile number.
        if (!/^[A-Z0-9-]{5,20}$/.test(values.nic_number)) throw validationError('Please enter a valid passport number (letters and numbers only).');
        if (!values.country) throw validationError('Please enter your country.');
        values.mobile = String(values.mobile).replace(/[\s()-]/g, '');
        if (!/^\+?\d{7,15}$/.test(values.mobile)) throw validationError('Please enter your mobile number with the country code, for example +960 7771234.');
      } else {
        if (!M.isValidNic(values.nic_number)) throw validationError('Please enter a valid NIC number (9 digits with V or X, or 12 digits).');
        values.mobile = M.checkPhone(values.mobile, 'mobile', 'Mobile number');
        values.country = null;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) throw validationError('Please enter a valid email address.');

      // Members are checked against the register; their fee follows their category.
      // A number not in the register is accepted at the fee for its prefix (member_id stays empty, so the admin sees it).
      let feeCategory = 'NM';
      let member = null;
      let membershipNumber = null;
      if (req.body.registrant_type === 'member') {
        const parsed = M.parseMembershipNumber(req.body.membership_number);
        if (!parsed) throw validationError(NUMBER_FORMAT);
        member = await M.findMemberByNumber(req.body.membership_number);
        if (!member && !parsed.number) throw validationError(needYear(parsed));
        if (member) {
          const quote = await memberQuote(event, member);
          if (!quote.eligible) throw validationError(quote.message);
        }
        feeCategory = member ? member.category : parsed.category;
        membershipNumber = member ? member.membership_number : parsed.number;
      } else if (foreign) {
        // Attending online (FO) or physically (FP).
        feeCategory = req.body.attendance === 'physical' ? 'FP' : req.body.attendance === 'online' ? 'FO' : null;
        if (!feeCategory) throw validationError('Please choose whether you will attend online or physically.');
        if (E.feeFor(event, feeCategory) === null) throw validationError(`Foreign participants can't attend this event ${req.body.attendance === 'physical' ? 'physically' : 'online'}.`);
      } else if (req.body.registrant_type !== 'non_member') {
        throw validationError('Please choose whether you are registering as a member or a non-member.');
      }

      const amountDue = E.feeFor(event, feeCategory);
      if (amountDue === null) throw validationError('This event is for SLICNA members only.');

      const receiptKey = uploadedKey(req, 'receipt');
      let payment = { pay_by: null, payment_date: null };
      if (amountDue > 0) {
        payment = parseFields(req.body, PAYMENT_FIELDS);
        if (payment.payment_date > M.today()) throw validationError('Payment date cannot be in the future.');
        if (!receiptKey) throw validationError('Please upload your payment slip.');
      } else if (receiptKey) {
        discardUploads(req);
      }

      const row = {
        reference_number: req.registrationReference,
        event_id: event.id,
        event_title: event.title,
        event_date: event.event_date,
        registrant_type: foreign ? 'foreign' : membershipNumber ? 'member' : 'non_member',
        member_id: member ? member.id : null,
        membership_number: membershipNumber,
        fee_category: feeCategory,
        amount_due: amountDue,
        currency: foreign ? 'USD' : 'LKR',
        ...values,
        ...payment,
        receipt_key: amountDue > 0 ? receiptKey : null,
      };
      const columns = Object.keys(row);
      let saved;
      let seats = null;
      // One registration at a time per event (row lock), so a seat limit with a hard stop is never overshot.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = (await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [event.id])).rows[0];
        if (locked.seats_closed) throw validationError(SEATS_FULL);
        if (usesSeats(locked) && locked.seat_hard_stop && await seatsTaken(client, locked.id) >= Number(locked.seat_limit)) throw validationError(SEATS_FULL);
        saved = (await client.query(
          `INSERT INTO event_registrations (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          Object.values(row)
        )).rows[0];
        seats = await syncSeats(client, locked, { afterRegistration: true });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code !== '23505') throw err;
        const existing = (await pool.query(
          "SELECT reference_number FROM event_registrations WHERE event_id = $1 AND upper(nic_number) = $2 AND status <> 'rejected'",
          [event.id, values.nic_number]
        )).rows[0];
        throw Object.assign(new Error(`This ${foreign ? 'passport number' : 'NIC'} is already registered for this event${existing ? ` (reference ${existing.reference_number})` : ''}.`), { statusCode: 409 });
      } finally {
        client.release();
      }
      // 80 / 95 / 100 % of the seats, or closed automatically: tell the secretary.
      if (seats && (seats.alert || seats.closedNow)) {
        sendMailInBackground(emails.secretarySeatAlert(seats.event, seats.taken, seats.alert || 100, seats.closedNow));
      }

      sendMailInBackground(emails.registrationReceived(saved));
      sendMailInBackground(emails.secretaryNewRegistration(saved));
      res.status(201).json({
        reference_number: saved.reference_number,
        amount_due: saved.amount_due,
        currency: saved.currency,
        event_title: saved.event_title,
        email: saved.email,
      });
    } catch (err) {
      discardUploads(req);
      next(err);
    }
  }
);

module.exports = router;
