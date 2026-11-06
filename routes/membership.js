// routes/membership.js
// Public membership endpoints (no login):
//   GET  /api/membership/info              fees, bank details, grace period
//   POST /api/membership/applications      submit an application (multipart)
//   POST /api/membership/status            check an application (reference + NIC)
//   POST /api/membership/renew/lookup      membership number + NIC -> renewal token
//   GET  /api/membership/renew/:token      what the renewal page shows
//   POST /api/membership/renew/:token      submit a renewal or upgrade (multipart)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const M = require('../lib/membership');
const { parseFields, validationError } = require('../lib/crud');
const { privateUpload, uploadedKey, discardUploads, PRIVATE_ROOT } = require('../lib/private-files');
const { sendMailInBackground } = require('../lib/mail');
const emails = require('../lib/membership-emails');

const router = express.Router();

const limiter = (max, minutes, message, extra = {}) => rateLimit({
  windowMs: minutes * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: message }, ...extra,
});
// Only successful submissions count, so fixing a validation error and resubmitting isn't blocked.
const applyLimiter = limiter(5, 60, 'Too many applications from this device. Please try again later.', { skipFailedRequests: true });
const lookupLimiter = limiter(20, 15, 'Too many attempts. Please wait 15 minutes and try again.');

// ---------- Info ----------

router.get('/info', async (req, res, next) => {
  try {
    const [fees, settings] = await Promise.all([M.loadFees(), M.loadSettings()]);
    res.json({ fees: Object.values(fees), bank: settings.bank, grace_days: settings.graceDays });
  } catch (err) {
    next(err);
  }
});

// ---------- Applications ----------

// Reference numbers: <category>-<date applied, YYYYMMDD>-<6-character code>, e.g.
// LT-20261106-7KQ2M9. The code avoids look-alike characters (0/O, 1/I).
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => [...crypto.randomBytes(6)].map((b) => REF_CHARS[b % REF_CHARS.length]).join('');
const referenceFor = (category, code) => `${category}-${M.today().replace(/-/g, '')}-${code}`;

// Every field on the paper forms is required, except the ones SLNA's online
// join form also leaves optional: WhatsApp, residential and office phones and
// higher qualifications. SLNC and SLNA numbers are required unless the
// applicant ticks "I don't have it yet" (handled in the route below).
const COMMON_FIELDS = {
  title: { type: 'enum', label: 'Title', required: true, values: M.TITLES },
  full_name: { type: 'text', label: 'Name in full', required: true, max: 255 },
  name_with_initials: { type: 'text', label: 'Name with initials', required: true, max: 255 },
  nic_number: { type: 'text', label: 'NIC number', required: true, max: 20 },
  date_of_birth: { type: 'date', label: 'Date of birth', required: true },
  sex: { type: 'enum', label: 'Sex', required: true, values: ['Male', 'Female'] },
  marital_status: { type: 'enum', label: 'Marital status', required: true, values: M.MARITAL_STATUSES },
  permanent_address: { type: 'text', label: 'Permanent address', required: true, max: 500 },
  current_working_place: { type: 'text', label: 'Current working place', required: true, max: 255 },
  official_address: { type: 'text', label: 'Official address', required: true, max: 500 },
  designation: { type: 'text', label: 'Designation', required: true, max: 255 },
  mobile: { type: 'text', label: 'Mobile number', required: true, max: 30 },
  whatsapp: { type: 'text', label: 'WhatsApp number', max: 30 },
  residential_phone: { type: 'text', label: 'Residential phone', max: 30 },
  office_phone: { type: 'text', label: 'Office phone', max: 30 },
  email: { type: 'text', label: 'Email', required: true, max: 255 },
  nursing_school: { type: 'text', label: 'Nursing school / university', required: true, max: 255 },
  batch: { type: 'text', label: 'Batch', required: true, max: 50 },
  higher_qualifications: { type: 'text', label: 'Higher educational qualifications', max: 2000 },
  payment_date: { type: 'date', label: 'Payment date', required: true },
};

const SLNA_FIELDS = {
  slna_number: { type: 'text', label: 'SLNA membership number', required: true, max: 50 },
  slna_date: { type: 'date', label: 'SLNA registration date', required: true },
};

const SLNC_FIELDS = {
  slnc_number: { type: 'text', label: 'SLNC registration number', required: true, max: 50 },
  slnc_date: { type: 'date', label: 'SLNC registration date', required: true },
};

const NURSE_FIELDS = {
  first_appointment_date: { type: 'date', label: 'First appointment date', required: true },
  first_appointment_place: { type: 'text', label: 'First appointment place', required: true, max: 255 },
};

const CATEGORY_FIELDS = {
  LT: {
    ...NURSE_FIELDS,
    icu_training_batch: { type: 'text', label: 'ICU training batch (PBCN)', required: true, max: 50 },
    icu_training_type: { type: 'enum', label: 'ICU training (diploma or certificate)', required: true, values: ['diploma', 'certificate'] },
    icu_training_year: { type: 'int', label: 'ICU training year', required: true, min: 1950, max: 2100 },
  },
  GM: { ...NURSE_FIELDS },
  OM: { ...NURSE_FIELDS },
  PM: {
    student_number: { type: 'text', label: 'Student number', required: true, max: 50 },
    institute_registration_date: { type: 'date', label: 'Date of registration at the institute', required: true },
  },
};

// Files are saved before the form fields are read, so the category (the
// start of the reference) isn't known yet: they go into an upload-<code>
// folder that is renamed to membership/applications/<reference>/ once the
// application is accepted.
function assignReference(req, res, next) {
  req.referenceCode = newCode();
  next();
}

const APPLICATIONS_DIR = path.join(PRIVATE_ROOT, 'membership', 'applications');

// Moves the uploads to the reference's folder; returns the new file keys.
function moveUploadsTo(req, reference) {
  fs.renameSync(path.join(APPLICATIONS_DIR, `upload-${req.referenceCode}`), path.join(APPLICATIONS_DIR, reference));
  const rekey = (key) => key.replace(`membership/applications/upload-${req.referenceCode}/`, `membership/applications/${reference}/`);
  return { photo_key: rekey(uploadedKey(req, 'photo')), receipt_key: rekey(uploadedKey(req, 'receipt')) };
}

router.post(
  '/applications',
  applyLimiter,
  assignReference,
  privateUpload((req) => `membership/applications/upload-${req.referenceCode}`, { photo: 'image', receipt: 'document' }),
  async (req, res, next) => {
    let reference = null;
    try {
      const category = String(req.body.category || '').toUpperCase();
      if (!M.CATEGORIES[category]) throw validationError('Please choose a membership category.');

      // As in SLNA's join form, ticking "I don't have my SLNC/SLNA number yet"
      // drops those two fields; otherwise the number and its date are required.
      const slncNotRegistered = category !== 'PM' && req.body.slnc_not_registered === 'true';
      const slnaNotMember = req.body.slna_not_member === 'true';
      const values = {
        ...parseFields(req.body, COMMON_FIELDS),
        ...parseFields(req.body, CATEGORY_FIELDS[category]),
        ...(category !== 'PM' && !slncNotRegistered ? parseFields(req.body, SLNC_FIELDS) : { slnc_number: null, slnc_date: null }),
        ...(!slnaNotMember ? parseFields(req.body, SLNA_FIELDS) : { slna_number: null, slna_date: null }),
        slnc_not_registered: slncNotRegistered,
        slna_not_member: slnaNotMember,
      };
      values.nic_number = M.normaliseNic(values.nic_number);
      if (!M.isValidNic(values.nic_number)) throw validationError('Please enter a valid NIC number (9 digits with V or X, or 12 digits).');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) throw validationError('Please enter a valid email address.');
      values.mobile = M.checkPhone(values.mobile, 'mobile', 'Mobile number');
      values.whatsapp = M.checkPhone(values.whatsapp, 'phone', 'WhatsApp number');
      values.residential_phone = M.checkPhone(values.residential_phone, 'phone', 'Residential phone');
      values.office_phone = M.checkPhone(values.office_phone, 'phone', 'Office phone');
      if (req.body.declaration !== 'true') throw validationError('Please confirm that the details you entered are true.');

      if (!uploadedKey(req, 'photo')) throw validationError('Please upload a passport-size photo.');
      if (!uploadedKey(req, 'receipt')) throw validationError('Please upload your payment slip or receipt.');

      const member = (await pool.query('SELECT 1 FROM members WHERE upper(nic_number) = $1', [values.nic_number])).rows[0];
      if (member) throw validationError('A member with this NIC number already exists. To renew or upgrade, use "Renew membership".');
      const open = (await pool.query(
        "SELECT reference_number FROM membership_applications WHERE upper(nic_number) = $1 AND status IN ('pending', 'more_info_required')",
        [values.nic_number]
      )).rows[0];
      if (open) throw validationError(`You already have an application in progress (${open.reference_number}). You can check it on the "Check application status" page.`);

      const fees = await M.loadFees();
      reference = referenceFor(category, req.referenceCode);
      const files = moveUploadsTo(req, reference);
      const row = {
        ...values,
        reference_number: reference,
        category,
        ...files,
        payment_amount: fees[category].amount,
        declaration_confirmed: true,
      };
      const cols = Object.keys(row);
      const app = (await pool.query(
        `INSERT INTO membership_applications (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        Object.values(row)
      )).rows[0];

      sendMailInBackground(emails.applicationReceived(app));
      sendMailInBackground(emails.secretaryNewApplication(app));
      res.status(201).json({ reference_number: app.reference_number, category: app.category, status: app.status });
    } catch (err) {
      discardUploads(req);
      fs.rm(path.join(APPLICATIONS_DIR, `upload-${req.referenceCode}`), { recursive: true, force: true }, () => {});
      if (reference) fs.rm(path.join(APPLICATIONS_DIR, reference), { recursive: true, force: true }, () => {});
      next(err);
    }
  }
);

const STATUS_MESSAGES = {
  pending: 'Your application has been received and is waiting for review.',
  more_info_required: 'We need more information to continue with your application.',
  approved: 'Your application has been approved. Welcome to SLICNA!',
  rejected: 'Your application could not be approved.',
};

router.post('/status', lookupLimiter, async (req, res, next) => {
  try {
    const reference = String(req.body.reference_number || '').trim().toUpperCase();
    const nic = M.normaliseNic(req.body.nic_number);
    const notFound = () => res.status(404).json({ error: 'No application matches that reference number and NIC. Please check both and try again.' });
    if (!reference || !nic) return notFound();

    const app = (await pool.query(
      'SELECT * FROM membership_applications WHERE reference_number = $1 AND upper(nic_number) = $2',
      [reference, nic]
    )).rows[0];
    if (!app) return notFound();

    const member = app.status === 'approved'
      ? (await pool.query('SELECT membership_number, category, valid_until FROM members WHERE application_id = $1', [app.id])).rows[0]
      : null;
    res.json({
      reference_number: app.reference_number,
      category: app.category,
      category_label: M.CATEGORIES[app.category],
      name_with_initials: app.name_with_initials,
      submitted_at: app.created_at,
      status: app.status,
      status_message: STATUS_MESSAGES[app.status],
      status_note: app.status_note,
      follow_up: emails.applicantFollowUp(app),
      membership_number: member ? member.membership_number : null,
      valid_until: member ? member.valid_until : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Renewals ----------

router.post('/renew/lookup', lookupLimiter, async (req, res, next) => {
  try {
    const number = M.compactNumber(req.body.membership_number);
    const nic = M.normaliseNic(req.body.nic_number);
    // Either NIC format matches (old 9 digits + V/X, or new 12 digits).
    const member = number && nic
      ? (await pool.query(
        "SELECT id FROM members WHERE regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g') = $1 AND upper(nic_number) = ANY($2)",
        [number, M.nicVariants(nic)]
      )).rows[0]
      : null;
    if (!member) return res.status(404).json({ error: 'No member matches that membership number and NIC. Please check both and try again.' });
    res.json({ token: await M.createRenewalToken(member.id, 1) });
  } catch (err) {
    next(err);
  }
});

async function renewalView(member) {
  const [settings, fees] = await Promise.all([M.loadSettings(), M.loadFees()]);
  const state = M.memberState(member, settings);
  const latest = (await pool.query(
    'SELECT kind, to_category, status, status_note, payment_reference, new_valid_until, created_at, reviewed_at FROM renewal_requests WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1',
    [member.id]
  )).rows[0] || null;
  const isLifetime = member.category === 'LT';
  return {
    member: {
      name_with_initials: member.name_with_initials,
      membership_number: member.membership_number,
      category: member.category,
      category_label: M.CATEGORIES[member.category],
      valid_until: member.valid_until,
      state,
      state_label: M.STATE_LABELS[state],
      email: member.email,
      mobile: member.mobile,
      current_working_place: member.current_working_place,
    },
    renewal: isLifetime || state === 'deactivated' ? null : {
      amount: fees[member.category].amount,
      new_valid_until: M.renewedValidUntil(member, settings),
    },
    upgrade: isLifetime || state === 'deactivated' ? null : { to_category: 'LT', label: M.CATEGORIES.LT, amount: fees.LT.amount },
    payment_reference: M.paymentReference(member),
    latest_request: latest,
    bank: settings.bank,
  };
}

router.get('/renew/:token', lookupLimiter, async (req, res, next) => {
  try {
    const member = await M.memberForToken(req.params.token);
    if (!member) return res.status(404).json({ error: 'This renewal link has expired or is not valid. You can still renew with your membership number and NIC.' });
    res.json(await renewalView(member));
  } catch (err) {
    next(err);
  }
});

const RENEWAL_FIELDS = {
  kind: { type: 'enum', label: 'Renewal type', required: true, values: ['renewal', 'upgrade'] },
  nic_number: { type: 'text', label: 'NIC number', required: true, max: 20 },
  email: { type: 'text', label: 'Email', max: 255 },
  mobile: { type: 'text', label: 'Mobile number', max: 30 },
  current_working_place: { type: 'text', label: 'Current working place', max: 255 },
  payment_date: { type: 'date', label: 'Payment date', required: true },
};

// Upgrading to Lifetime needs the Lifetime requirement: PBCN ICU training
// (same fields and rules as the Lifetime application form).
const UPGRADE_FIELDS = {
  icu_training_batch: { type: 'text', label: 'ICU training batch (PBCN)', required: true, max: 50 },
  icu_training_type: { type: 'enum', label: 'ICU training (diploma or certificate)', required: true, values: ['diploma', 'certificate'] },
  icu_training_year: { type: 'int', label: 'ICU training year', required: true, min: 1950, max: 2100 },
};

router.post(
  '/renew/:token',
  lookupLimiter,
  async (req, res, next) => {
    try {
      req.renewalMember = await M.memberForToken(req.params.token);
      if (!req.renewalMember) return res.status(404).json({ error: 'This renewal link has expired or is not valid. Please start again from the Renew membership page.' });
      next();
    } catch (err) {
      next(err);
    }
  },
  privateUpload((req) => `membership/renewals/${req.renewalMember.id}`, { receipt: 'document' }),
  async (req, res, next) => {
    const member = req.renewalMember;
    try {
      const values = parseFields(req.body, RENEWAL_FIELDS);
      const upgrade = values.kind === 'upgrade'
        ? parseFields(req.body, UPGRADE_FIELDS)
        : { icu_training_batch: null, icu_training_type: null, icu_training_year: null };
      if (!M.nicMatches(member.nic_number, values.nic_number)) throw validationError('This NIC number does not match our records for this membership.');
      if (!uploadedKey(req, 'receipt')) throw validationError('Please upload your payment slip or receipt.');
      values.mobile = M.checkPhone(values.mobile, 'mobile', 'Mobile number');
      if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) throw validationError('Please enter a valid email address.');

      const view = await renewalView(member);
      if (values.kind === 'renewal' && !view.renewal) throw validationError('This membership does not need renewing.');
      if (values.kind === 'upgrade' && !view.upgrade) throw validationError('This membership cannot be upgraded.');
      const pending = (await pool.query("SELECT 1 FROM renewal_requests WHERE member_id = $1 AND status = 'pending'", [member.id])).rows[0];
      if (pending) throw validationError('Your previous renewal is still being verified. You will hear from us soon.');

      const request = (await pool.query(
        `INSERT INTO renewal_requests (member_id, kind, from_category, to_category, amount, payment_reference, payment_date,
           receipt_key, email, mobile, current_working_place, previous_valid_until,
           icu_training_batch, icu_training_type, icu_training_year)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [
          member.id, values.kind, member.category, values.kind === 'upgrade' ? 'LT' : member.category,
          values.kind === 'upgrade' ? view.upgrade.amount : view.renewal.amount, view.payment_reference, values.payment_date,
          uploadedKey(req, 'receipt'), values.email, values.mobile, values.current_working_place, member.valid_until,
          upgrade.icu_training_batch, upgrade.icu_training_type, upgrade.icu_training_year,
        ]
      )).rows[0];

      sendMailInBackground(emails.renewalSubmitted(member, request));
      sendMailInBackground(emails.secretaryRenewalSubmitted(member, request));
      res.status(201).json({ payment_reference: request.payment_reference, status: request.status });
    } catch (err) {
      discardUploads(req);
      next(err);
    }
  }
);

module.exports = router;
