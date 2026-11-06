// routes/events-admin.js
// Admin event and registration endpoints, all under /api/events/admin and
// all requiring a staff login:
//
//   GET    /overview                              registrations waiting for review
//   Events
//   GET    /events                                every event with registration counts
//   POST   /events                                add (multipart: photo, attachment PDF)
//   PUT    /events/:id                            edit (remove_image / remove_attachment)
//   DELETE /events/:id                            delete (only without registrations)
//   GET    /events/:id/registrations.xlsx         Excel file of all registrations
//   GET    /events/:id/registrations.pdf          attendance sheet (confirmed only)
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
const { writeRegistrationsPdf } = require('../lib/registrations-pdf');
const emails = require('../lib/event-emails');

const router = express.Router();
router.use(requireAuth);
const form = multer().none();
const notFound = (res, what = 'Not found.') => res.status(404).json({ error: what });

// ---------- Event uploads: a photo (public image) and an optional PDF ----------

const UPLOAD_TYPES = {
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  attachment: ['application/pdf'],
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
    if (!types) return cb(new Error('Unexpected upload field: ' + file.fieldname + '. Only listed files are allowed.'));
    if (!types.includes(file.mimetype)) {
      return cb(new Error(file.fieldname === 'photo' ? 'For the photo, only JPEG, PNG, WEBP or GIF images are allowed.' : 'For the attachment, only PDF files are allowed.'));
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
  end_date: { type: 'date', label: 'End date' },
  time_text: { type: 'text', label: 'Time', max: 100 },
  location: { type: 'text', label: 'Venue', max: 300 },
  summary: { type: 'text', label: 'Summary', max: 1000 },
  body: { type: 'text', label: 'Details', max: 20000 },
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
};
const FEE_COLUMNS = ['member_fee', 'fee_lt', 'fee_gm', 'fee_om', 'fee_pm', 'non_member_fee'];

// Clean values for one event: the type and status must fit the kind; only
// the fee columns the chosen pricing uses are kept (the rest are cleared).
function eventValues(body) {
  const v = parseFields(body, EVENT_FIELDS);
  if (v.end_date && v.end_date < v.event_date) throw validationError('End date cannot be before the start date.');
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
      fees: E.feeSummary(e),
    })));
  } catch (err) {
    next(err);
  }
});

// Lists for the admin form's dropdowns.
router.get('/options', (req, res) => {
  res.json({ kinds: E.KINDS, event_types: E.EVENT_TYPES, statuses: E.STATUSES, audiences: E.AUDIENCES });
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
    res.status(existing ? 200 : 201).json(result.rows[0]);
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
const REG_STATUS_LABELS = { pending: 'Pending', confirmed: 'Confirmed', rejected: 'Rejected' };

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
      `SELECT r.id, r.reference_number, r.event_id, r.event_title, r.event_date, r.registrant_type, r.membership_number,
              r.fee_category, r.amount_due, r.full_name, r.nic_number, r.workplace, r.status, r.created_at
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

const FEE_LABELS = { LT: 'Lifetime member', GM: 'General member', OM: 'Ordinary member', PM: 'Partial member', NM: 'Non-member' };
const fileSlug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

async function eventWithRegistrations(id, statuses) {
  const event = (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];
  if (!event) return null;
  const regs = (await pool.query(
    'SELECT * FROM event_registrations WHERE event_id = $1 AND status = ANY($2) ORDER BY upper(certificate_name)',
    [id, statuses]
  )).rows;
  return { event, regs };
}

// Every registration for the event (all statuses) as an Excel workbook.
router.get('/events/:id/registrations.xlsx', async (req, res, next) => {
  try {
    const found = await eventWithRegistrations(parseId(req.params.id), REG_STATUSES);
    if (!found) return notFound(res, 'Event not found.');
    const date = (v) => (v ? new Date(String(v instanceof Date ? v.toISOString() : v).slice(0, 10) + 'T00:00:00Z') : null);
    const book = new ExcelJS.Workbook();
    book.creator = 'SLICNA admin';
    const sheet = book.addWorksheet('Registrations', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Reference', key: 'reference_number', width: 16 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Registered on', key: 'created_at', width: 14, style: { numFmt: 'dd mmm yyyy' } },
      { header: 'Full name', key: 'full_name', width: 30 },
      { header: 'Name on certificate', key: 'certificate_name', width: 30 },
      { header: 'NIC', key: 'nic_number', width: 15 },
      { header: 'Registered as', key: 'registered_as', width: 18 },
      { header: 'Membership number', key: 'membership_number', width: 18 },
      { header: 'SLNC number', key: 'slnc_number', width: 14 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Mobile', key: 'mobile', width: 14 },
      { header: 'Workplace', key: 'workplace', width: 28 },
      { header: 'Workplace address', key: 'workplace_address', width: 32 },
      { header: 'Postal address', key: 'postal_address', width: 32 },
      { header: 'Fee (LKR)', key: 'amount_due', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'Paid by', key: 'pay_by', width: 14 },
      { header: 'Payment date', key: 'payment_date', width: 14, style: { numFmt: 'dd mmm yyyy' } },
      { header: 'Note', key: 'status_note', width: 36 },
    ];
    found.regs.forEach((r) => sheet.addRow({
      ...r,
      status: REG_STATUS_LABELS[r.status],
      created_at: date(r.created_at),
      registered_as: FEE_LABELS[r.fee_category],
      amount_due: Number(r.amount_due),
      pay_by: r.pay_by ? (r.pay_by === 'organisation' ? 'Organisation' : 'Individual') : '',
      payment_date: date(r.payment_date),
    }));
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6B67' } };
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columns.length } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSlug(found.event.title)}-registrations.xlsx"`);
    await book.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/events/:id/registrations.pdf', async (req, res, next) => {
  try {
    const found = await eventWithRegistrations(parseId(req.params.id), ['confirmed']);
    if (!found) return notFound(res, 'Event not found.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSlug(found.event.title)}-attendance.pdf"`);
    writeRegistrationsPdf(res, found.event, found.regs, FEE_LABELS);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
