// routes/events-admin.js
// Admin event and registration endpoints, all under /api/events/admin and
// all requiring a staff login:
//
//   GET    /overview                              registrations waiting for review
//   Events
//   GET    /events                                every event with registration counts
//   POST   /events                                add (multipart: photo, attachment PDF or image)
//   PUT    /events/:id                            edit (remove_image / remove_attachment)
//   PATCH  /events/:id/status                     open registration (from opening soon) or close it
//   DELETE /events/:id                            delete (only without registrations)
//   GET    /events/:id/registrations.xlsx?status=  Excel download (same rows as the PDF)
//   GET    /events/:id/registrations.pdf?status=   PDF download (A3 table)
//   Registrations
//   GET    /registrations?event_id=&status=&q=
//   GET    /registrations/counts?event_id=&q=     counts per status tab
//   GET    /registrations/:id
//   PATCH  /registrations/:id/status              confirm | reject (reason) | pending
//   DELETE /registrations/:id                     delete it and its payment slip
//   GET    /registrations/:id/receipt             payment slip (private)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const M = require('../lib/membership');
const E = require('../lib/events');
const { requireAuth } = require('../middleware/auth');
const { UPLOAD_ROOT } = require('../middleware/upload');
const { deleteUpload } = require('../lib/files');
const { parseFields, parseId, validationError } = require('../lib/crud');
const { deletePrivateFile, sendPrivateFile, PRIVATE_ROOT } = require('../lib/private-files');
const { sendMailInBackground } = require('../lib/mail');
const { COLUMNS: EXPORT_COLUMNS, STATUS_LABELS, sortForExport, writeRegistrationsPdf } = require('../lib/registrations-pdf');
const emails = require('../lib/event-emails');
const { syncSeats, usesSeats, seatsTaken } = require('../lib/event-seats');

const router = express.Router();
router.use(requireAuth);
const form = multer().none();
const notFound = (res, what = 'Not found.') => res.status(404).json({ error: what });

// ---------- Event uploads: a photo (public image) and an optional brochure (PDF or image) ----------

const UPLOAD_TYPES = {
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  attachment: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
};
const eventUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(UPLOAD_ROOT, 'events');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80)}`);
    },
  }),
  fileFilter(req, file, cb) {
    const types = UPLOAD_TYPES[file.fieldname];
    if (!types) return cb(Object.assign(new Error('Unexpected upload field: ' + file.fieldname + '. Only listed files are allowed.'), { statusCode: 400 }));
    if (!types.includes(file.mimetype)) {
      return cb(Object.assign(new Error(file.fieldname === 'photo' ? 'For the photo, only JPEG, PNG, WEBP or GIF images are allowed.' : 'For the programme or brochure, only a PDF or a JPEG, PNG or WEBP image is allowed.'), { statusCode: 400 }));
    }
    cb(null, true);
  },
  limits: { fileSize: 15 * 1024 * 1024, files: 2 },
}).fields([{ name: 'photo', maxCount: 1 }, { name: 'attachment', maxCount: 1 }]);

const uploaded = (req, field) => (req.files && req.files[field] ? req.files[field][0] : null);
const discardEventUploads = (req) => Object.values(req.files || {}).flat().forEach((f) => fs.unlink(f.path, () => {}));

// ---------- Event fields ----------

const money = { type: 'number', min: 0, max: 1000000 };
const EVENT_FIELDS = {
  title: { type: 'text', label: 'Title', required: true, max: 300 },
  category: { type: 'enum', label: 'Event kind', required: true, values: Object.keys(E.KINDS) },
  event_type: { type: 'text', label: 'Type', required: true, max: 60 },
  status: { type: 'text', label: 'Status', required: true, max: 20 },
  event_date: { type: 'date', label: 'Date', required: true },
  duration_number: { type: 'int', label: 'Duration', min: 1, max: 366, default: 1 },
  duration_unit: { type: 'enum', label: 'Duration unit', values: Object.keys(E.DURATION_UNITS), default: 'day' },
  end_date: { type: 'date', label: 'Exact end date' },
  start_time: { type: 'text', label: 'Start time', max: 5 },
  end_time: { type: 'text', label: 'End time', max: 5 },
  time_text: { type: 'text', label: 'Time', max: 100 },
  registration_mode: { type: 'enum', label: 'Registration', values: ['online', 'external', 'none'], default: 'online' },
  registration_url: { type: 'text', label: 'Registration link', max: 500 },
  join_url: { type: 'text', label: 'Meeting link', max: 500 },
  location: { type: 'text', label: 'Venue', max: 300 },
  summary: { type: 'text', label: 'Summary', max: 1000 },
  body: { type: 'text', label: 'Details', max: 100000 },
  cpd_points: { type: 'number', label: 'CPD points', min: 0, max: 100 },
  audience: { type: 'enum', label: 'Audience', values: Object.keys(E.AUDIENCES), default: 'public' },
  fee_type: { type: 'enum', label: 'Fee', values: ['free', 'paid'], default: 'free' },
  member_pricing: { type: 'enum', label: 'Member fees', values: ['same', 'by_category'], default: 'same' },
  member_fee: { ...money, label: 'Member fee' },
  fee_lt: { ...money, label: 'Lifetime member fee' },
  fee_gm: { ...money, label: 'General member fee' },
  fee_om: { ...money, label: 'Ordinary member fee' },
  fee_pm: { ...money, label: 'Partial member fee' },
  non_member_fee: { ...money, label: 'Non-member fee' },
  foreign_online: { type: 'enum', label: 'Foreign participants online', values: ['true', 'false'], default: 'false' },
  foreign_physical: { type: 'enum', label: 'Foreign participants physical', values: ['true', 'false'], default: 'false' },
  foreign_fee_online: { ...money, label: 'Foreign participant fee (online)' },
  foreign_fee_physical: { ...money, label: 'Foreign participant fee (physical)' },
  seat_limit: { type: 'int', label: 'Number of seats', min: 1, max: 100000 },
  seat_hard_stop: { type: 'enum', label: 'Close when full', values: ['true', 'false'], default: 'false' },
};
const FEE_COLUMNS = ['member_fee', 'fee_lt', 'fee_gm', 'fee_om', 'fee_pm', 'non_member_fee'];

// Clean values for one event: the type and status must fit the kind; only
// the fee columns the chosen pricing uses are kept (the rest are cleared).
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /^https?:\/\/\S+$/i;

function eventValues(body) {
  const v = parseFields(body, EVENT_FIELDS);
  if (v.end_date && v.end_date < v.event_date) throw validationError('End date cannot be before the start date.');
  // Time: a start (and end) time, or free text instead.
  if (v.time_text) {
    v.start_time = null;
    v.end_time = null;
  } else {
    if (v.start_time && !TIME_RE.test(v.start_time)) throw validationError('Please choose a valid start time.');
    if (v.end_time && !TIME_RE.test(v.end_time)) throw validationError('Please choose a valid end time.');
    if (v.end_time && !v.start_time) throw validationError('Please choose a start time as well.');
  }
  // Registration: on this site, on another site (a link), or none (an open meeting).
  if (v.category !== 'cpd') v.registration_mode = 'online';
  if (v.registration_url && !URL_RE.test(v.registration_url)) throw validationError('The registration link must start with http:// or https://.');
  if (v.join_url && !URL_RE.test(v.join_url)) throw validationError('The meeting link must start with http:// or https://.');
  if (v.registration_mode === 'external' && !v.registration_url) throw validationError('Please add the registration link.');
  if (v.registration_mode !== 'external') v.registration_url = null;
  if (v.registration_mode === 'none') {
    // Nothing to open or close, and no fees.
    v.status = 'open';
    v.fee_type = 'free';
  }
  if (!E.EVENT_TYPES[v.category].includes(v.event_type)) throw validationError(`Please choose a type for this ${v.category === 'cpd' ? 'CPD event' : 'event'}.`);
  if (!E.STATUSES[v.category][v.status]) throw validationError(`Please choose a status for this ${v.category === 'cpd' ? 'CPD event' : 'event'}.`);

  const keep = new Set();
  if (v.category === 'other') {
    Object.assign(v, { cpd_points: null, audience: 'public', fee_type: 'free', member_pricing: 'same' });
  } else if (v.fee_type === 'paid') {
    const required = v.member_pricing === 'by_category' ? ['fee_lt', 'fee_gm', 'fee_om', 'fee_pm'] : ['member_fee'];
    if (v.audience === 'public') required.push('non_member_fee');
    required.forEach((col) => {
      if (v[col] === null) throw validationError(`${EVENT_FIELDS[col].label} is required (enter 0 if it's free).`);
      keep.add(col);
    });
    if (required.every((col) => v[col] === 0)) throw validationError('Every fee is 0. Choose "Free" instead.');
  } else {
    v.member_pricing = 'same';
  }
  FEE_COLUMNS.forEach((col) => { if (!keep.has(col)) v[col] = null; });

  // Foreign participants: CPD events open to everyone; online and/or physical,
  // each with a USD fee when the event is paid.
  v.foreign_online = v.foreign_online === 'true';
  v.foreign_physical = v.foreign_physical === 'true';
  if (v.category !== 'cpd' || v.audience !== 'public' || v.registration_mode === 'none') {
    v.foreign_online = false;
    v.foreign_physical = false;
  }
  [['foreign_online', 'foreign_fee_online', 'online'], ['foreign_physical', 'foreign_fee_physical', 'physical']].forEach(([on, fee, mode]) => {
    if (!v[on] || v.fee_type !== 'paid') v[fee] = null;
    else if (v[fee] === null) throw validationError(`Please enter the fee for foreign participants attending ${mode} (USD; enter 0 if it's free).`);
  });

  // Seats: only for CPD events registered on this website; the hard stop needs a number.
  v.seat_hard_stop = v.seat_hard_stop === 'true';
  if (v.category !== 'cpd' || v.registration_mode !== 'online') v.seat_limit = null;
  if (!v.seat_limit) v.seat_hard_stop = false;
  return v;
}

// ---------- Overview and events ----------

router.get('/overview', async (req, res, next) => {
  try {
    const row = (await pool.query("SELECT count(*)::int AS n FROM event_registrations WHERE status = 'pending'")).rows[0];
    res.json({ pending_registrations: row.n });
  } catch (err) {
    next(err);
  }
});

router.get('/events', async (req, res, next) => {
  try {
    const today = M.today();
    const rows = (await pool.query(
      `SELECT e.*,
              count(r.id) FILTER (WHERE r.status = 'pending')::int AS registrations_pending,
              count(r.id) FILTER (WHERE r.status = 'confirmed')::int AS registrations_confirmed,
              count(r.id) FILTER (WHERE r.status = 'rejected')::int AS registrations_rejected,
              count(r.id)::int AS registrations_total
       FROM events e LEFT JOIN event_registrations r ON r.event_id = e.id
       GROUP BY e.id ORDER BY e.event_date DESC, e.id DESC`
    )).rows;
    res.json(rows.map((e) => ({
      ...e,
      status_label: E.isPast(e, today) ? 'Completed' : E.STATUSES[e.category][e.status],
      is_past: E.isPast(e, today),
      is_ongoing: E.isOngoing(e, today),
      ends_on: E.endDateOf(e), // end_date stays the exact date typed in (or null)
      duration_text: E.durationText(e),
      fees: E.feeSummary(e),
      foreign: E.foreignOptions(e),
    })));
  } catch (err) {
    next(err);
  }
});

// Lists for the admin form's dropdowns.
router.get('/options', (req, res) => {
  res.json({ kinds: E.KINDS, event_types: E.EVENT_TYPES, statuses: E.STATUSES, audiences: E.AUDIENCES, duration_units: E.DURATION_UNITS });
});

async function saveEvent(req, res, next, existing) {
  try {
    const values = eventValues(req.body);
    const photo = uploaded(req, 'photo');
    const attachment = uploaded(req, 'attachment');
    const oldFiles = [];
    if (photo) {
      values.photo_url = `/uploads/events/${photo.filename}`;
      if (existing) oldFiles.push(existing.photo_url);
    } else if (existing && req.body.remove_image === 'true') {
      values.photo_url = null;
      oldFiles.push(existing.photo_url);
    }
    if (attachment) {
      values.attachment_url = `/uploads/events/${attachment.filename}`;
      values.attachment_name = attachment.originalname.slice(0, 255);
      if (existing) oldFiles.push(existing.attachment_url);
    } else if (existing && req.body.remove_attachment === 'true') {
      values.attachment_url = null;
      values.attachment_name = null;
      oldFiles.push(existing.attachment_url);
    }

    const columns = Object.keys(values);
    const result = existing
      ? await pool.query(
        `UPDATE events SET ${columns.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${columns.length + 1} RETURNING *`,
        [...Object.values(values), existing.id]
      )
      : await pool.query(
        `INSERT INTO events (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        Object.values(values)
      );
    oldFiles.forEach(deleteUpload);
    const saved = await withLockedEvent(result.rows[0].id, (client, event) => syncSeats(client, event));
    res.status(existing ? 200 : 201).json(saved.event);
  } catch (err) {
    discardEventUploads(req);
    next(err);
  }
}

router.post('/events', eventUpload, (req, res, next) => saveEvent(req, res, next, null));

router.put('/events/:id', eventUpload, async (req, res, next) => {
  try {
    const existing = (await pool.query('SELECT * FROM events WHERE id = $1', [parseId(req.params.id)])).rows[0];
    if (!existing) {
      discardEventUploads(req);
      return notFound(res, 'Event not found.');
    }
    saveEvent(req, res, next, existing);
  } catch (err) {
    discardEventUploads(req);
    next(err);
  }
});

// Opens or closes registration without editing the whole event:
// "Registration Opening Soon" -> open, and open -> closed. Upcoming CPD events only.
const REGISTRATION_SWITCH = { open: 'opening_soon', closed: 'open' };

// Runs fn(client, lockedEvent) in a transaction; returns its result.
async function withLockedEvent(id, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = (await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!event) throw Object.assign(new Error('Event not found.'), { statusCode: 404 });
    const out = await fn(client, event);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Reopens an event closed because its seats were filled (or adds seats any time):
// add = extra seats (0 or more); hard_stop = keep closing automatically at the new number.
router.post('/events/:id/seats', form, async (req, res, next) => {
  try {
    const { add, hard_stop: hardStop } = parseFields(req.body, {
      add: { type: 'int', label: 'Seats to add', min: 0, max: 10000, default: 0 },
      hard_stop: { type: 'enum', label: 'Close when full', values: ['true', 'false'], default: 'false' },
    });
    const out = await withLockedEvent(parseId(req.params.id), async (client, event) => {
      if (!usesSeats(event)) throw validationError('This event has no seat limit.');
      const taken = await seatsTaken(client, event.id);
      const limit = Number(event.seat_limit) + add;
      if (hardStop === 'true' && limit <= taken) {
        throw validationError(`${taken} seats are taken. Add at least ${taken - Number(event.seat_limit) + 1} seat${taken - Number(event.seat_limit) + 1 === 1 ? '' : 's'} to reopen, or untick "Close again when full".`);
      }
      const updated = (await client.query(
        'UPDATE events SET seat_limit = $1, seat_hard_stop = $2, seats_closed = false, updated_at = now() WHERE id = $3 RETURNING *',
        [limit, hardStop === 'true', event.id]
      )).rows[0];
      return syncSeats(client, updated);
    });
    res.json({ ...out.event, seats_taken: out.taken });
  } catch (err) {
    next(err);
  }
});

router.patch('/events/:id/status', form, async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!REGISTRATION_SWITCH[status]) throw validationError('Status must be open or closed.');
    const event = (await pool.query('SELECT * FROM events WHERE id = $1', [parseId(req.params.id)])).rows[0];
    if (!event) return notFound(res, 'Event not found.');
    if (event.category !== 'cpd' || E.isPast(event, M.today())) throw validationError('Only upcoming CPD events take registrations.');
    if (event.status !== REGISTRATION_SWITCH[status]) {
      throw validationError(status === 'open'
        ? 'Registration can be opened only while it is "Registration Opening Soon".'
        : 'Registration is not open, so it cannot be closed.');
    }
    const row = (await pool.query('UPDATE events SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [status, event.id])).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/events/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const count = (await pool.query('SELECT count(*)::int AS n FROM event_registrations WHERE event_id = $1', [id])).rows[0].n;
    if (count) {
      return res.status(409).json({ error: `This event has ${count} registration${count > 1 ? 's' : ''}, so it can't be deleted. Delete the registrations first, or keep the event.` });
    }
    const row = (await pool.query('DELETE FROM events WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!row) return notFound(res, 'Event not found.');
    deleteUpload(row.photo_url);
    deleteUpload(row.attachment_url);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Registrations ----------

const REG_STATUSES = ['pending', 'confirmed', 'rejected'];

function registrationFilters(query, where = [], params = []) {
  const eventId = parseId(query.event_id);
  if (eventId) where.push(`r.event_id = $${params.push(eventId)}`);
  if (query.q) {
    const p = params.push('%' + String(query.q).trim() + '%');
    where.push(`(r.full_name ILIKE $${p} OR r.certificate_name ILIKE $${p} OR r.nic_number ILIKE $${p} OR r.reference_number ILIKE $${p} OR r.email ILIKE $${p} OR r.membership_number ILIKE $${p} OR r.workplace ILIKE $${p})`);
  }
  return { where, params };
}
const whereSql = (where) => (where.length ? 'WHERE ' + where.join(' AND ') : '');

router.get('/registrations/counts', async (req, res, next) => {
  try {
    const { where, params } = registrationFilters(req.query);
    res.json((await pool.query(
      `SELECT count(*) FILTER (WHERE r.status = 'pending')::int AS pending,
              count(*) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
              count(*) FILTER (WHERE r.status = 'rejected')::int AS rejected,
              count(*)::int AS "all"
       FROM event_registrations r ${whereSql(where)}`,
      params
    )).rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/registrations', async (req, res, next) => {
  try {
    const { where, params } = registrationFilters(req.query);
    if (REG_STATUSES.includes(req.query.status)) where.push(`r.status = $${params.push(req.query.status)}`);
    res.json((await pool.query(
      `SELECT r.id, r.reference_number, r.event_id, r.event_title, r.event_date, r.registrant_type, r.membership_number, r.member_id,
              r.fee_category, r.amount_due, r.currency, r.country, r.full_name, r.nic_number, r.email, r.workplace, r.pay_by, r.receipt_key IS NOT NULL AS has_receipt,
              r.status, r.created_at
       FROM event_registrations r ${whereSql(where)}
       ORDER BY CASE r.status WHEN 'pending' THEN 1 ELSE 2 END, r.created_at DESC`,
      params
    )).rows);
  } catch (err) {
    next(err);
  }
});

const getRegistration = async (id) => (id ? (await pool.query('SELECT * FROM event_registrations WHERE id = $1', [id])).rows[0] : null);

router.get('/registrations/:id', async (req, res, next) => {
  try {
    const reg = await getRegistration(parseId(req.params.id));
    if (!reg) return notFound(res, 'Registration not found.');
    const reviewer = reg.reviewed_by ? (await pool.query('SELECT username FROM users WHERE id = $1', [reg.reviewed_by])).rows[0] : null;
    const member = reg.member_id
      ? (await pool.query('SELECT id, membership_number, category, valid_until, is_active FROM members WHERE id = $1', [reg.member_id])).rows[0]
      : null;
    res.json({ ...reg, reviewed_by_name: reviewer ? reviewer.username : null, member });
  } catch (err) {
    next(err);
  }
});

router.patch('/registrations/:id/status', form, async (req, res, next) => {
  try {
    const reg = await getRegistration(parseId(req.params.id));
    if (!reg) return notFound(res, 'Registration not found.');
    const values = parseFields(req.body, {
      status: { type: 'enum', label: 'Status', required: true, values: REG_STATUSES },
      status_note: { type: 'text', label: 'Message', max: 2000 },
      admin_notes: { type: 'text', label: 'Internal notes', max: 5000 },
    });
    if (values.status === 'rejected' && !values.status_note) throw validationError('Please give a reason for rejecting this registration.');
    if (values.status === reg.status) throw validationError('The registration already has this status.');
    // Moving back to pending re-opens the NIC check: another live registration may exist.
    const updated = (await pool.query(
      `UPDATE event_registrations SET status = $1, status_note = $2, admin_notes = COALESCE($3, admin_notes),
              reviewed_by = $4, reviewed_at = now(), updated_at = now()
       WHERE id = $5 RETURNING *`,
      [values.status, values.status_note, values.admin_notes, req.user.id, reg.id]
    ).catch((err) => {
      if (err.code === '23505') throw validationError('This person already has another registration for this event, so this one cannot be re-opened.');
      throw err;
    })).rows[0];
    if (values.status !== 'pending') sendMailInBackground(emails.registrationReviewed(updated));
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/registrations/:id', async (req, res, next) => {
  try {
    const reg = (await pool.query('DELETE FROM event_registrations WHERE id = $1 RETURNING *', [parseId(req.params.id)])).rows[0];
    if (!reg) return notFound(res, 'Registration not found.');
    if (reg.receipt_key) deletePrivateFile(reg.receipt_key);
    fs.rm(path.join(PRIVATE_ROOT, 'events', String(reg.event_id), 'registrations', reg.reference_number), { recursive: true, force: true }, () => {});
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/registrations/:id/receipt', async (req, res, next) => {
  try {
    const reg = await getRegistration(parseId(req.params.id));
    if (!reg || !reg.receipt_key) return notFound(res, 'Payment slip not found.');
    sendPrivateFile(res, reg.receipt_key, `${reg.reference_number}-payment-slip`);
  } catch (err) {
    next(err);
  }
});

// ---------- Exports ----------

const fileSlug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);

// The rows for both downloads: ?status=pending|confirmed|rejected (default all),
// confirmed first, then pending, then rejected, each oldest first (as in SLNA).
async function exportRows(req) {
  const event = (await pool.query('SELECT * FROM events WHERE id = $1', [parseId(req.params.id)])).rows[0];
  if (!event) return null;
  const status = REG_STATUSES.includes(req.query.status) ? req.query.status : null;
  const regs = (await pool.query(
    `SELECT * FROM event_registrations WHERE event_id = $1 ${status ? 'AND status = $2' : ''}`,
    status ? [event.id, status] : [event.id]
  )).rows;
  const label = status ? STATUS_LABELS[status] : 'All';
  return { event, regs: sortForExport(regs), label, filename: `registrations-${fileSlug(event.title).toLowerCase()}-${label.toLowerCase()}` };
}

router.get('/events/:id/registrations.xlsx', async (req, res, next) => {
  try {
    const found = await exportRows(req);
    if (!found) return notFound(res, 'Event not found.');
    const book = new ExcelJS.Workbook();
    book.creator = 'SLICNA admin';
    const sheet = book.addWorksheet('Registrations', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = EXPORT_COLUMNS.map((c, i) => ({ header: c.label, key: String(i), width: c.excel, ...(c.money ? { style: { numFmt: '#,##0.00' } } : {}) }));
    found.regs.forEach((r, n) => sheet.addRow(Object.fromEntries(EXPORT_COLUMNS.map((c, i) => [String(i), c.value(r, n)]))));
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF083F3D' } };
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: EXPORT_COLUMNS.length } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${found.filename}.xlsx"`);
    await book.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/events/:id/registrations.pdf', async (req, res, next) => {
  try {
    const found = await exportRows(req);
    if (!found) return notFound(res, 'Event not found.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${found.filename}.pdf"`);
    writeRegistrationsPdf(res, found.event, found.regs, found.label);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
