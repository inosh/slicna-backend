// routes/membership-admin.js
// Admin membership endpoints, all under /api/membership/admin and all
// requiring a staff login:
//
//   GET    /overview                         counts for the dashboard
//   GET    /next-number?category=GM           suggested membership number
//   Applications
//   GET    /applications?status=&category=&q=   status=id_application: approved, ID application not yet created
//   GET    /applications/counts?category=&q=  counts per tab (statuses, id_application, all)
//   GET    /applications/:id                  full details
//   PATCH  /applications/:id/status           review; approving creates the member
//   DELETE /applications/:id                  delete (not approved ones) and its files
//   GET    /applications/:id/files/:kind      photo | receipt (private)
//   GET    /applications/:id/id-application.pdf   ID card application form (approved only)
//   GET    /applications/:id/id-photo             passport photo, named for the ID card
//   POST   /applications/:id/id-application       confirm the ID application was created
//   Members
//   GET    /members?state=&category=&record=&q=  directory with computed state (state=current: not deactivated;
//                                             record=legacy | full)
//   GET    /members/counts?category=&q=        counts per status tab
//   GET    /members/export.xlsx               Excel file of the current list
//   GET    /members/:id                       details, renewal history, reminders
//   POST   /members                           add a member manually (optional photo)
//   POST   /members/legacy                    add a legacy member (number, name, dates; the rest optional)
//   PUT    /members/:id                       edit details (optional new photo)
//   POST   /members/:id/deactivate | /reactivate   (reactivate can renew or upgrade at the same time)
//   GET    /members/:id/photo | /id-photo     inline | download for the ID card
//   GET    /members/:id/id-application.pdf    ID card application form
//   POST   /members/:id/id-application        confirm the ID application was created
//   POST   /members/:id/renewal-link          new renewal link (optionally emailed)
//   POST   /members/:id/payments              renew / upgrade with a payment taken offline
//   Renewals
//   GET    /renewals?status=
//   GET    /renewals/counts                   counts per status tab
//   GET    /renewals/:id/receipt
//   PATCH  /renewals/:id                      verify or reject
//   Settings
//   GET    /settings  PUT /settings  PUT /fees/:category
//   POST   /reminders/run                     send due renewal reminders now

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const M = require('../lib/membership');
const { requireAuth } = require('../middleware/auth');
const { parseFields, parseId, validationError } = require('../lib/crud');
const { privateUpload, uploadedKey, discardUploads, deletePrivateFile, deletePrivateFolder, privateFileBuffer, sendPrivateFile } = require('../lib/private-files');
const storage = require('../lib/storage');
const { sendMail, sendMailInBackground, emailConfigured } = require('../lib/mail');
const { runReminders } = require('../lib/reminders');
const ExcelJS = require('exceljs');
const { writeIdApplicationPdf, idApplicationFilename, idPhotoFilename } = require('../lib/id-application-pdf');
const emails = require('../lib/membership-emails');

const router = express.Router();
router.use(requireAuth);
const form = multer().none();

const notFound = (res, what = 'Not found.') => res.status(404).json({ error: what });

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Throws a 400 if the membership number is malformed or already used by another member.
async function checkMembershipNumber(client, number, category, exceptMemberId = null) {
  const typed = String(number || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!typed) throw validationError('Membership number is required.');
  // "GM/001/2023" (old cards) -> "GM 0001/23".
  const parsed = M.parseMembershipNumber(typed);
  const value = parsed && parsed.number ? parsed.number : typed;
  if (!value.startsWith(category)) throw validationError(`A ${M.CATEGORIES[category]} number must start with "${category}".`);
  const taken = (await client.query(
    "SELECT id FROM members WHERE regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g') = $1 AND id IS DISTINCT FROM $2",
    [M.compactNumber(value), exceptMemberId]
  )).rows[0];
  if (taken) throw validationError(`Membership number ${value} is already in use.`);
  // Numbers given up on an upgrade stay reserved (except for the member who held it).
  const retired = (await client.query(
    `SELECT m.name_with_initials, m.membership_number AS now FROM retired_membership_numbers r LEFT JOIN members m ON m.id = r.member_id
     WHERE regexp_replace(upper(r.membership_number), '[^A-Z0-9]', '', 'g') = $1 AND r.member_id IS DISTINCT FROM $2`,
    [M.compactNumber(value), exceptMemberId]
  )).rows[0];
  if (retired) {
    throw validationError(`Membership number ${value} is reserved: it was used by ${retired.name_with_initials || 'a former member'}${retired.now ? ` (now ${retired.now})` : ''} and is not reused.`);
  }
  return value;
}

function withState(member, settings, pendingIds = new Set()) {
  const state = M.memberState(member, settings);
  return { ...member, state, state_label: M.STATE_LABELS[state], has_pending_renewal: pendingIds.has(member.id) };
}

// ---------- Overview ----------

router.get('/overview', async (req, res, next) => {
  try {
    const settings = await M.loadSettings();
    const apps = (await pool.query('SELECT status, count(*)::int AS n FROM membership_applications GROUP BY status')).rows;
    const renewals = (await pool.query("SELECT count(*)::int AS n FROM renewal_requests WHERE status = 'pending'")).rows[0].n;
    const idApplications = (await pool.query(
      "SELECT count(*)::int AS n FROM membership_applications a JOIN members m ON m.application_id = a.id WHERE a.status = 'approved' AND m.id_application_created_at IS NULL"
    )).rows[0].n;
    const members = (await pool.query('SELECT category, valid_until, is_active FROM members')).rows;
    const states = { active: 0, renewal_due: 0, grace: 0, lapsed: 0, deactivated: 0 };
    members.forEach((m) => { states[M.memberState(m, settings)] += 1; });
    res.json({
      applications: Object.fromEntries(apps.map((a) => [a.status, a.n])),
      pending_renewals: renewals,
      id_applications_pending: idApplications,
      members: { total: members.length, ...states },
      email_configured: emailConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/next-number', async (req, res, next) => {
  try {
    const category = String(req.query.category || '').toUpperCase();
    if (!M.CATEGORIES[category]) throw validationError('Unknown category.');
    res.json({ membership_number: await M.suggestMembershipNumber(category, req.query.joined_on || M.today()) });
  } catch (err) {
    next(err);
  }
});

// ---------- Applications ----------

// pending -> approved | rejected, with more_info_required while waiting on the applicant.
const APP_STATUSES = ['pending', 'more_info_required', 'approved', 'rejected'];

// Approved, member created, ID application not yet confirmed.
const ID_QUEUE = "a.status = 'approved' AND m.id IS NOT NULL AND m.id_application_created_at IS NULL";

// Category and search conditions (on membership_applications a LEFT JOIN members m).
function applicationFilters(query, where = [], params = []) {
  if (M.CATEGORIES[query.category]) where.push(`a.category = $${params.push(query.category)}`);
  if (query.q) {
    const p = params.push('%' + String(query.q).trim() + '%');
    where.push(`(a.full_name ILIKE $${p} OR a.name_with_initials ILIKE $${p} OR a.nic_number ILIKE $${p} OR a.reference_number ILIKE $${p} OR a.email ILIKE $${p} OR m.membership_number ILIKE $${p})`);
  }
  return { where, params };
}

// Counts for the tabs, following the same category and search filters.
router.get('/applications/counts', async (req, res, next) => {
  try {
    const { where, params } = applicationFilters(req.query);
    const row = (await pool.query(
      `SELECT count(*) FILTER (WHERE a.status = 'pending')::int AS pending,
              count(*) FILTER (WHERE a.status = 'more_info_required')::int AS more_info_required,
              count(*) FILTER (WHERE a.status = 'approved')::int AS approved,
              count(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
              count(*) FILTER (WHERE ${ID_QUEUE})::int AS id_application,
              count(*)::int AS "all"
       FROM membership_applications a LEFT JOIN members m ON m.application_id = a.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params
    )).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.get('/applications', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (APP_STATUSES.includes(req.query.status)) where.push(`a.status = $${params.push(req.query.status)}`);
    const idQueue = req.query.status === 'id_application';
    if (idQueue) where.push(ID_QUEUE);
    applicationFilters(req.query, where, params);
    const rows = (await pool.query(
      `SELECT a.id, a.reference_number, a.category, a.status, a.title, a.name_with_initials, a.full_name, a.nic_number, a.email, a.mobile,
              a.current_working_place, a.payment_amount, a.created_at, a.updated_at, a.approved_at,
              m.id AS member_id, m.membership_number, m.id_application_created_at
       FROM membership_applications a LEFT JOIN members m ON m.application_id = a.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${idQueue ? 'a.approved_at,' : "CASE a.status WHEN 'pending' THEN 1 WHEN 'more_info_required' THEN 2 ELSE 3 END,"} a.created_at DESC`,
      params
    )).rows;
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

async function getApplication(id) {
  return id ? (await pool.query('SELECT * FROM membership_applications WHERE id = $1', [id])).rows[0] : null;
}

router.get('/applications/:id', async (req, res, next) => {
  try {
    const app = await getApplication(parseId(req.params.id));
    if (!app) return notFound(res, 'Application not found.');

    const member = (await pool.query(
      `SELECT m.id, m.membership_number, m.valid_until, m.photo_key IS NOT NULL AS has_photo,
              m.id_application_created_at, u.username AS id_application_created_by_name
       FROM members m LEFT JOIN users u ON u.id = m.id_application_created_by WHERE m.application_id = $1`, [app.id]
    )).rows[0] || null;
    const reviewer = app.reviewed_by ? (await pool.query('SELECT username FROM users WHERE id = $1', [app.reviewed_by])).rows[0] : null;
    res.json({ ...app, member, reviewed_by_name: reviewer ? reviewer.username : null });
  } catch (err) {
    next(err);
  }
});

const STATUS_FIELDS = {
  status: { type: 'enum', label: 'Status', required: true, values: APP_STATUSES },
  status_note: { type: 'text', label: 'Message to the applicant', max: 2000 },
  admin_notes: { type: 'text', label: 'Internal notes', max: 5000 },
  membership_number: { type: 'text', label: 'Membership number', max: 30 },
  joined_on: { type: 'date', label: 'Membership start date' },
};

router.patch('/applications/:id/status', form, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const values = parseFields(req.body, STATUS_FIELDS);
    if (values.status === 'more_info_required' && !values.status_note) {
      throw validationError('Please tell the applicant what information is needed.');
    }
    if (values.status === 'rejected' && !values.status_note) {
      throw validationError('Please give the applicant a reason for the rejection.');
    }

    const { app, member } = await withTransaction(async (client) => {
      const current = (await client.query('SELECT * FROM membership_applications WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!current) throw Object.assign(new Error('Application not found.'), { statusCode: 404 });
      if (current.status === 'approved') throw validationError('This application is already approved and can no longer be changed. Edit the member in the Member directory instead.');

      let created = null;
      if (values.status === 'approved') {
        // Memberships start on the day the application was submitted. For
        // annual categories the admin may confirm a different date; Lifetime
        // memberships never expire, so their start date is not adjustable.
        const submittedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date(current.created_at));
        const joinedOn = current.category === 'LT' ? submittedOn : values.joined_on || submittedOn;
        const number = await checkMembershipNumber(client, values.membership_number, current.category);
        const existing = (await client.query('SELECT membership_number FROM members WHERE upper(nic_number) = upper($1)', [current.nic_number])).rows[0];
        if (existing) throw validationError(`A member with this NIC already exists (${existing.membership_number}).`);
        created = (await client.query(
          `INSERT INTO members (membership_number, category, title, full_name, name_with_initials, nic_number, date_of_birth, sex,
             email, mobile, whatsapp, current_working_place, designation, joined_on, valid_until, photo_key, application_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'application') RETURNING *`,
          [number, current.category, current.title, current.full_name, current.name_with_initials, current.nic_number,
            current.date_of_birth, current.sex, current.email, current.mobile, current.whatsapp, current.current_working_place,
            current.designation, joinedOn, current.category === 'LT' ? null : M.addYear(joinedOn), current.photo_key, current.id]
        )).rows[0];
      }

      const updated = (await client.query(
        `UPDATE membership_applications SET status = $1::varchar, status_note = $2, admin_notes = COALESCE($3, admin_notes),
           reviewed_by = $4, reviewed_at = now(), approved_at = CASE WHEN $1::varchar = 'approved' THEN now() ELSE approved_at END, updated_at = now()
         WHERE id = $5 RETURNING *`,
        [values.status, values.status_note, values.admin_notes, req.user.id, id]
      )).rows[0];
      return { app: updated, member: created };
    });

    if (app.status !== 'pending') sendMailInBackground(emails.applicationStatusChanged(app, member));
    if (app.status === 'approved') sendMailInBackground(emails.secretaryApplicationApproved(app, member, req.user.username));
    res.json({ application: app, member });
  } catch (err) {
    next(err);
  }
});

router.delete('/applications/:id', async (req, res, next) => {
  try {
    const app = await getApplication(parseId(req.params.id));
    if (!app) return notFound(res, 'Application not found.');
    if (app.status === 'approved') throw validationError('Approved applications cannot be deleted. Deactivate the member instead.');
    await pool.query('DELETE FROM membership_applications WHERE id = $1', [app.id]);
    [app.photo_key, app.receipt_key].forEach(deletePrivateFile);
    deletePrivateFolder(`membership/applications/${app.reference_number}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const FILE_KINDS = { photo: 'photo_key', receipt: 'receipt_key' };

router.get('/applications/:id/files/:kind', async (req, res, next) => {
  try {
    const app = await getApplication(parseId(req.params.id));
    const column = FILE_KINDS[req.params.kind];
    if (!app || !column || !app[column]) return notFound(res, 'File not found.');
    sendPrivateFile(res, app[column], `${app.reference_number}-${req.params.kind}`);
  } catch (err) {
    next(err);
  }
});

// ---------- ID card application ----------
// Done once the member exists: download the form and the photo, check them,
// then confirm. The status is kept on the member, so the Applications tab and
// the member directory show the same thing.

async function sendIdApplicationPdf(req, res, member, app) {
  const admin = (await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id])).rows[0];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${idApplicationFilename(member)}"`);
  let photo = null;
  try {
    photo = await privateFileBuffer(member.photo_key || (app && app.photo_key));
  } catch (err) {
    console.error('Could not read the photo for the ID application', err.message);
  }
  writeIdApplicationPdf(res, member, app, { generatedBy: admin && admin.username, photo });
}

function sendIdPhoto(res, member, app) {
  const key = member.photo_key || (app && app.photo_key);
  if (!key) return notFound(res, 'This member has no photo.');
  sendPrivateFile(res, key, idPhotoFilename(member, key).replace(/\.[^.]+$/, ''), { attachment: true });
}

async function confirmIdApplication(req, memberId) {
  return (await pool.query(
    `UPDATE members SET id_application_created_at = now(), id_application_created_by = $2, updated_at = now()
     WHERE id = $1 RETURNING id, membership_number, id_application_created_at`,
    [memberId, req.user.id]
  )).rows[0];
}

// The approved application and its member; otherwise sends an error and returns null.
async function approvedApplication(req, res) {
  const app = await getApplication(parseId(req.params.id));
  if (!app) {
    notFound(res, 'Application not found.');
    return null;
  }
  const member = app.status === 'approved' ? (await pool.query('SELECT * FROM members WHERE application_id = $1', [app.id])).rows[0] : null;
  if (!member) {
    res.status(409).json({ error: 'The ID application is available once the application is approved and the member is created.' });
    return null;
  }
  return { app, member };
}

router.get('/applications/:id/id-application.pdf', async (req, res, next) => {
  try {
    const found = await approvedApplication(req, res);
    if (found) await sendIdApplicationPdf(req, res, found.member, found.app);
  } catch (err) {
    next(err);
  }
});

router.get('/applications/:id/id-photo', async (req, res, next) => {
  try {
    const found = await approvedApplication(req, res);
    if (found) sendIdPhoto(res, found.member, found.app);
  } catch (err) {
    next(err);
  }
});

router.post('/applications/:id/id-application', async (req, res, next) => {
  try {
    const found = await approvedApplication(req, res);
    if (!found) return;
    if (found.member.id_application_created_at) return res.status(409).json({ error: 'The ID application was already confirmed.' });
    res.json(await confirmIdApplication(req, found.member.id));
  } catch (err) {
    next(err);
  }
});

// ---------- Members ----------

const STATES = Object.keys(M.STATE_LABELS);

async function listMembers(query) {
  const settings = await M.loadSettings();
  const where = [];
  const params = [];
  if (M.CATEGORIES[query.category]) where.push(`category = $${params.push(query.category)}`);
  if (query.record === 'legacy') where.push("source = 'legacy'");
  else if (query.record === 'full') where.push("source <> 'legacy'");
  if (query.q) {
    const p = params.push('%' + String(query.q).trim() + '%');
    where.push(`(full_name ILIKE $${p} OR name_with_initials ILIKE $${p} OR nic_number ILIKE $${p} OR membership_number ILIKE $${p} OR email ILIKE $${p} OR mobile ILIKE $${p}
      OR EXISTS (SELECT 1 FROM retired_membership_numbers r WHERE r.member_id = members.id AND r.membership_number ILIKE $${p}))`);
  }
  const rows = (await pool.query(
    `SELECT * FROM members ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, membership_number`,
    params
  )).rows;
  const pending = new Set((await pool.query("SELECT member_id FROM renewal_requests WHERE status = 'pending'")).rows.map((r) => r.member_id));
  let members = rows.map((m) => withState(m, settings, pending));
  if (query.state === 'pending_renewal') members = members.filter((m) => m.has_pending_renewal);
  else if (query.state === 'current') members = members.filter((m) => m.state !== 'deactivated');
  else if (STATES.includes(query.state)) members = members.filter((m) => m.state === query.state);
  return members;
}

router.get('/members', async (req, res, next) => {
  try {
    res.json((await listMembers(req.query)).map(({ admin_notes, photo_key, ...m }) => ({ ...m, has_photo: Boolean(photo_key) })));
  } catch (err) {
    next(err);
  }
});

// Counts for the directory tabs, following the category and search filters.
router.get('/members/counts', async (req, res, next) => {
  try {
    const members = await listMembers({ category: req.query.category, record: req.query.record, q: req.query.q });
    const counts = { current: 0, active: 0, renewal_due: 0, grace: 0, lapsed: 0, deactivated: 0, pending_renewal: 0 };
    members.forEach((m) => {
      counts[m.state] += 1;
      if (m.state !== 'deactivated') counts.current += 1;
      if (m.has_pending_renewal) counts.pending_renewal += 1;
    });
    res.json(counts);
  } catch (err) {
    next(err);
  }
});

// The list as shown (same filters) as an Excel workbook.
router.get('/members/export.xlsx', async (req, res, next) => {
  try {
    const members = await listMembers(req.query);
    const book = new ExcelJS.Workbook();
    book.creator = 'SLICNA admin';
    const sheet = book.addWorksheet('Members', { views: [{ state: 'frozen', ySplit: 1 }] });
    const date = (v) => (v ? new Date(String(v).slice(0, 10) + 'T00:00:00Z') : null);
    sheet.columns = [
      { header: 'Membership number', key: 'membership_number', width: 18 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Renewal to verify', key: 'pending', width: 16 },
      { header: 'Title', key: 'title', width: 8 },
      { header: 'Name with initials', key: 'name_with_initials', width: 26 },
      { header: 'Full name', key: 'full_name', width: 34 },
      { header: 'NIC', key: 'nic_number', width: 15 },
      { header: 'Date of birth', key: 'date_of_birth', width: 13, style: { numFmt: 'dd mmm yyyy' } },
      { header: 'Sex', key: 'sex', width: 8 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Mobile', key: 'mobile', width: 14 },
      { header: 'WhatsApp', key: 'whatsapp', width: 14 },
      { header: 'Working place', key: 'current_working_place', width: 28 },
      { header: 'Designation', key: 'designation', width: 22 },
      { header: 'Member since', key: 'joined_on', width: 13, style: { numFmt: 'dd mmm yyyy' } },
      { header: 'Valid until', key: 'valid_until', width: 13, style: { numFmt: 'dd mmm yyyy' } },
      { header: 'Joined through', key: 'source', width: 16 },
    ];
    members.forEach((m) => sheet.addRow({
      ...m,
      category: M.CATEGORIES[m.category],
      status: m.state_label,
      pending: m.has_pending_renewal ? 'Yes' : '',
      date_of_birth: date(m.date_of_birth),
      joined_on: date(m.joined_on),
      valid_until: m.valid_until ? date(m.valid_until) : 'Lifetime',
      source: m.source === 'legacy' ? 'Old records' : m.source === 'manual' ? 'Added by admin' : 'Online application',
    }));
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6B67' } };
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columns.length } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="slicna-members-${M.today()}.xlsx"`);
    await book.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

async function getMember(id, client = pool) {
  return id ? (await client.query('SELECT * FROM members WHERE id = $1', [id])).rows[0] : null;
}

router.get('/members/:id', async (req, res, next) => {
  try {
    const member = await getMember(parseId(req.params.id));
    if (!member) return notFound(res, 'Member not found.');
    const settings = await M.loadSettings();
    const renewals = (await pool.query(
      `SELECT r.*, u.username AS reviewed_by_name FROM renewal_requests r LEFT JOIN users u ON u.id = r.reviewed_by
       WHERE r.member_id = $1 ORDER BY r.created_at DESC`, [member.id]
    )).rows;
    const reminders = (await pool.query('SELECT kind, period_key, status, detail, created_at FROM reminder_log WHERE member_id = $1 ORDER BY created_at DESC LIMIT 30', [member.id])).rows;
    const previousNumbers = (await pool.query('SELECT membership_number, reason, retired_at FROM retired_membership_numbers WHERE member_id = $1 ORDER BY retired_at', [member.id])).rows;
    const app = member.application_id
      ? (await pool.query('SELECT id, reference_number FROM membership_applications WHERE id = $1', [member.application_id])).rows[0]
      : null;
    const pending = new Set(renewals.filter((r) => r.status === 'pending').map(() => member.id));
    const idConfirmer = member.id_application_created_by
      ? (await pool.query('SELECT username FROM users WHERE id = $1', [member.id_application_created_by])).rows[0]
      : null;
    res.json({
      ...withState(member, settings, pending),
      id_application_created_by_name: idConfirmer ? idConfirmer.username : null,
      has_photo: Boolean(member.photo_key),
      grace_ends: member.valid_until ? M.addDays(member.valid_until, settings.graceDays) : null,
      application: app,
      previous_numbers: previousNumbers,
      renewals,
      reminders,
    });
  } catch (err) {
    next(err);
  }
});

const MEMBER_FIELDS = {
  category: { type: 'enum', label: 'Category', required: true, values: M.CATEGORY_KEYS },
  membership_number: { type: 'text', label: 'Membership number', required: true, max: 30 },
  title: { type: 'enum', label: 'Title', values: M.TITLES },
  full_name: { type: 'text', label: 'Name in full', required: true, max: 255 },
  name_with_initials: { type: 'text', label: 'Name with initials', required: true, max: 255 },
  nic_number: { type: 'text', label: 'NIC number', required: true, max: 20 },
  date_of_birth: { type: 'date', label: 'Date of birth' },
  sex: { type: 'enum', label: 'Sex', values: ['Male', 'Female'] },
  email: { type: 'text', label: 'Email', max: 255 },
  mobile: { type: 'text', label: 'Mobile', max: 30 },
  whatsapp: { type: 'text', label: 'WhatsApp', max: 30 },
  current_working_place: { type: 'text', label: 'Working place', max: 255 },
  designation: { type: 'text', label: 'Designation', max: 255 },
  joined_on: { type: 'date', label: 'Member since', required: true },
  valid_until: { type: 'date', label: 'Valid until' },
  admin_notes: { type: 'text', label: 'Internal notes', max: 5000 },
};

// legacy: a member from the old records, whose NIC may not be known yet.
async function memberValues(client, body, existingId = null, { legacy = false } = {}) {
  const values = parseFields(body, legacy ? { ...MEMBER_FIELDS, nic_number: { ...MEMBER_FIELDS.nic_number, required: false } } : MEMBER_FIELDS);
  values.nic_number = values.nic_number ? M.normaliseNic(values.nic_number) : null;
  if (values.nic_number && !M.isValidNic(values.nic_number)) throw validationError('Please enter a valid NIC number (9 digits with V or X, or 12 digits).');
  if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) throw validationError('Please enter a valid email address.');
  values.mobile = M.checkPhone(values.mobile, 'mobile', 'Mobile');
  values.whatsapp = M.checkPhone(values.whatsapp, 'phone', 'WhatsApp');
  values.membership_number = await checkMembershipNumber(client, values.membership_number, values.category, existingId);
  if (values.category === 'LT') values.valid_until = null;
  else if (!values.valid_until) values.valid_until = M.addYear(values.joined_on);
  const sameNic = values.nic_number
    ? (await client.query('SELECT membership_number FROM members WHERE upper(nic_number) = $1 AND id IS DISTINCT FROM $2', [values.nic_number, existingId])).rows[0]
    : null;
  if (sameNic) throw validationError(`Another member already has this NIC (${sameNic.membership_number}).`);
  return values;
}

// Legacy member: number, category, name, the year they joined and (GM / OM / PM)
// valid until; NIC, contact details and notes if known. Name with initials is
// worked out from the full name when left empty ("M. G. I. MADUSHIKA").
const LEGACY_FIELDS = {
  category: MEMBER_FIELDS.category,
  membership_number: MEMBER_FIELDS.membership_number,
  full_name: MEMBER_FIELDS.full_name,
  name_with_initials: { ...MEMBER_FIELDS.name_with_initials, required: false },
  joined_year: { type: 'int', label: 'Member since (year)', required: true, min: 1990, max: 2100 },
  valid_until: MEMBER_FIELDS.valid_until,
  nic_number: { ...MEMBER_FIELDS.nic_number, required: false },
  email: MEMBER_FIELDS.email,
  mobile: MEMBER_FIELDS.mobile,
  admin_notes: MEMBER_FIELDS.admin_notes,
};
const SURNAME_PARTICLES = new Set(['DE', 'DA', 'DI', 'DOS', 'VAN', 'LA', 'LE']);
// Sri Lankan style: every given name becomes an initial; the surname (with "DE", "DA"... ) stays.
function initialsOf(fullName) {
  const parts = String(fullName).replace(/\s+/g, ' ').trim().split(' ');
  if (parts.length < 2) return parts.join(' ');
  let cut = parts.length - 1;
  while (cut > 1 && SURNAME_PARTICLES.has(parts[cut - 1].replace(/\./g, '').toUpperCase())) cut -= 1;
  return [...parts.slice(0, cut).map((p) => `${p.replace(/\./g, '')[0]}.`), ...parts.slice(cut)].join(' ');
}

async function legacyValues(client, body) {
  const v = parseFields(body, LEGACY_FIELDS);
  const year = v.joined_year;
  delete v.joined_year;
  if (year > Number(M.today().slice(0, 4))) throw validationError('"Member since" cannot be a future year.');
  v.joined_on = `${year}-01-01`;
  v.full_name = v.full_name.replace(/\s+/g, ' ').trim();
  v.name_with_initials = v.name_with_initials ? v.name_with_initials.replace(/\s+/g, ' ').trim() : initialsOf(v.full_name);
  // Annual memberships without a date: valid to the end of this year.
  if (v.category !== 'LT' && !v.valid_until) v.valid_until = `${M.today().slice(0, 4)}-12-31`;
  return memberValues(client, { ...body, ...v, joined_on: v.joined_on, valid_until: v.valid_until || '' }, null, { legacy: true });
}

router.post('/members/legacy', form, async (req, res, next) => {
  try {
    const member = await withTransaction(async (client) => {
      const values = await legacyValues(client, req.body);
      const cols = Object.keys(values);
      return (await client.query(
        `INSERT INTO members (${cols.join(', ')}, source) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, 'legacy') RETURNING *`,
        Object.values(values)
      )).rows[0];
    });
    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

const memberPhotoUpload = (folderFn) => privateUpload(folderFn, { photo: 'image' });

router.post('/members', memberPhotoUpload(() => 'membership/members/new'), async (req, res, next) => {
  try {
    const member = await withTransaction(async (client) => {
      const values = await memberValues(client, req.body);
      const cols = Object.keys(values);
      const row = (await client.query(
        `INSERT INTO members (${cols.join(', ')}, source) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, 'manual') RETURNING *`,
        Object.values(values)
      )).rows[0];
      // Move the photo into the member's own folder now that the id is known.
      const file = req.files && req.files.photo && req.files.photo[0];
      if (file) {
        const key = await storage.move('private', file.key, `membership/members/${row.id}/${file.filename}`);
        file.key = key; // so a failure below removes the moved file
        await client.query('UPDATE members SET photo_key = $1 WHERE id = $2', [key, row.id]);
        row.photo_key = key;
      }
      return row;
    });
    res.status(201).json(member);
  } catch (err) {
    discardUploads(req);
    next(err);
  }
});

router.put('/members/:id', memberPhotoUpload((req) => `membership/members/${parseId(req.params.id) || 'unknown'}`), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const existing = await getMember(id);
    if (!existing) {
      discardUploads(req);
      return notFound(res, 'Member not found.');
    }
    const updated = await withTransaction(async (client) => {
      const values = await memberValues(client, req.body, id, { legacy: existing.source === 'legacy' });
      const newPhoto = uploadedKey(req, 'photo');
      if (newPhoto) values.photo_key = newPhoto;
      const cols = Object.keys(values);
      return (await client.query(
        `UPDATE members SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
        [...Object.values(values), id]
      )).rows[0];
    });
    // An application photo is kept with its application; only replace member-owned photos.
    if (uploadedKey(req, 'photo') && existing.photo_key && existing.photo_key.startsWith('membership/members/')) deletePrivateFile(existing.photo_key);
    res.json(updated);
  } catch (err) {
    discardUploads(req);
    next(err);
  }
});

router.post('/members/:id/deactivate', form, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw validationError('Please give a reason for deactivating this member.');
    const row = (await pool.query(
      'UPDATE members SET is_active = false, deactivated_reason = $1, deactivated_at = now(), updated_at = now() WHERE id = $2 RETURNING *',
      [reason, parseId(req.params.id)]
    )).rows[0];
    if (!row) return notFound(res, 'Member not found.');
    // The member is told only if the admin chose to (e.g. not for a duplicate record); the secretary always is.
    const notify = req.body.notify_member === 'true' && Boolean(row.email);
    if (notify) sendMailInBackground(emails.memberDeactivated(row));
    sendMailInBackground(emails.secretaryMemberStatus(row, { active: false, by: req.user.username, reason, memberEmailed: notify }));
    res.json({ success: true, member_emailed: notify });
  } catch (err) {
    next(err);
  }
});

router.get('/members/:id/photo', async (req, res, next) => {
  try {
    const member = await getMember(parseId(req.params.id));
    if (!member || !member.photo_key) return notFound(res, 'Photo not found.');
    sendPrivateFile(res, member.photo_key, `${M.compactNumber(member.membership_number)}-photo`);
  } catch (err) {
    next(err);
  }
});

const linkedApplication = async (member) => (member.application_id
  ? (await pool.query('SELECT * FROM membership_applications WHERE id = $1', [member.application_id])).rows[0]
  : null);

router.get('/members/:id/id-photo', async (req, res, next) => {
  try {
    const member = await getMember(parseId(req.params.id));
    if (!member) return notFound(res, 'Member not found.');
    sendIdPhoto(res, member, await linkedApplication(member));
  } catch (err) {
    next(err);
  }
});

router.get('/members/:id/id-application.pdf', async (req, res, next) => {
  try {
    const member = await getMember(parseId(req.params.id));
    if (!member) return notFound(res, 'Member not found.');
    await sendIdApplicationPdf(req, res, member, await linkedApplication(member));
  } catch (err) {
    next(err);
  }
});

router.post('/members/:id/id-application', async (req, res, next) => {
  try {
    const member = await getMember(parseId(req.params.id));
    if (!member) return notFound(res, 'Member not found.');
    if (member.id_application_created_at) return res.status(409).json({ error: 'The ID application was already confirmed.' });
    res.json(await confirmIdApplication(req, member.id));
  } catch (err) {
    next(err);
  }
});

router.post('/members/:id/renewal-link', form, async (req, res, next) => {
  try {
    const member = await getMember(parseId(req.params.id));
    if (!member) return notFound(res, 'Member not found.');
    if (member.category === 'LT') throw validationError('Lifetime members do not need to renew.');
    const url = M.renewalUrl(await M.createRenewalToken(member.id));
    let email = null;
    if (req.body.send_email === 'true') {
      const settings = await M.loadSettings();
      const state = M.memberState(member, settings);
      const kind = { renewal_due: 'notice', grace: 'expired', lapsed: 'lapsed' }[state] || 'notice';
      email = await sendMail(emails.renewalReminder(kind, member, url, member.valid_until && M.addDays(member.valid_until, settings.graceDays)));
    }
    res.json({ url, email });
  } catch (err) {
    next(err);
  }
});

// ---------- Renewals ----------

// Applies a verified renewal or upgrade to the member.
// Returns the updated member. An upgrade (to request.to_category) gives a
// number in that category's series; the old number is retired (reserved for
// good) and returned as updated.previous_membership_number.
async function applyRenewal(client, member, request, settings, upgradeNumber) {
  const updates = {};
  if (request.kind === 'upgrade') {
    const to = request.to_category;
    if (!M.UPGRADES[member.category].includes(to)) {
      throw validationError(`${M.CATEGORIES[member.category]} cannot be upgraded to ${M.CATEGORIES[to] || to}.`);
    }
    updates.category = to;
    updates.valid_until = M.upgradedValidUntil(member, to, settings);
    updates.membership_number = upgradeNumber
      ? await checkMembershipNumber(client, upgradeNumber, to, member.id)
      : await M.suggestMembershipNumber(to, M.today(), client);
    await client.query(
      "INSERT INTO retired_membership_numbers (membership_number, member_id, reason) VALUES ($1, $2, 'upgrade') ON CONFLICT DO NOTHING",
      [member.membership_number, member.id]
    );
  } else {
    updates.valid_until = M.renewedValidUntil(member, settings);
  }
  ['email', 'mobile', 'current_working_place'].forEach((k) => { if (request[k]) updates[k] = request[k]; });
  const cols = Object.keys(updates);
  const updated = (await client.query(
    `UPDATE members SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
    [...Object.values(updates), member.id]
  )).rows[0];
  if (request.kind === 'upgrade') updated.previous_membership_number = member.membership_number;
  return updated;
}

router.get('/renewals', async (req, res, next) => {
  try {
    const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const rows = (await pool.query(
      `SELECT r.*, m.membership_number, m.name_with_initials, m.category AS member_category, m.valid_until AS member_valid_until
       FROM renewal_requests r JOIN members m ON m.id = r.member_id
       ${status ? 'WHERE r.status = $1' : ''} ORDER BY r.created_at DESC LIMIT 300`,
      status ? [status] : []
    )).rows;
    res.json(rows.map(({ receipt_key, ...r }) => ({ ...r, has_receipt: Boolean(receipt_key) })));
  } catch (err) {
    next(err);
  }
});

router.get('/renewals/counts', async (req, res, next) => {
  try {
    res.json((await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'verified')::int AS verified,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              count(*)::int AS "all"
       FROM renewal_requests`
    )).rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/renewals/:id/receipt', async (req, res, next) => {
  try {
    const r = (await pool.query(
      'SELECT r.receipt_key, r.payment_reference FROM renewal_requests r WHERE r.id = $1', [parseId(req.params.id)]
    )).rows[0];
    if (!r || !r.receipt_key) return notFound(res, 'Receipt not found.');
    sendPrivateFile(res, r.receipt_key, `${r.payment_reference}-receipt`);
  } catch (err) {
    next(err);
  }
});

const REVIEW_FIELDS = {
  status: { type: 'enum', label: 'Decision', required: true, values: ['verified', 'rejected'] },
  status_note: { type: 'text', label: 'Message to the member', max: 2000 },
  membership_number: { type: 'text', label: 'New membership number', max: 30 },
};

router.patch('/renewals/:id', form, async (req, res, next) => {
  try {
    const values = parseFields(req.body, REVIEW_FIELDS);
    if (values.status === 'rejected' && !values.status_note) throw validationError('Please tell the member why the payment could not be verified.');
    const settings = await M.loadSettings();

    const { request, member } = await withTransaction(async (client) => {
      const current = (await client.query('SELECT * FROM renewal_requests WHERE id = $1 FOR UPDATE', [parseId(req.params.id)])).rows[0];
      if (!current) throw Object.assign(new Error('Renewal not found.'), { statusCode: 404 });
      if (current.status !== 'pending') throw validationError('This renewal has already been reviewed.');
      let member = await getMember(current.member_id, client);
      let newValidUntil = null;
      if (values.status === 'verified') {
        member = await applyRenewal(client, member, current, settings, values.membership_number);
        newValidUntil = member.valid_until;
      }
      const request = (await client.query(
        `UPDATE renewal_requests SET status = $1, status_note = $2, new_valid_until = $3, reviewed_by = $4, reviewed_at = now(),
           previous_membership_number = $6
         WHERE id = $5 RETURNING *`,
        [values.status, values.status_note, newValidUntil, req.user.id, current.id, member.previous_membership_number || null]
      )).rows[0];
      return { request, member };
    });

    sendMailInBackground(emails.renewalReviewed(member, request));
    if (request.status === 'verified') sendMailInBackground(emails.secretaryRenewalVerified(member, request, req.user.username));
    res.json({ request, member });
  } catch (err) {
    next(err);
  }
});

const PAYMENT_FIELDS = {
  kind: { type: 'enum', label: 'Payment for', required: true, values: ['renewal', 'upgrade'] },
  to_category: { type: 'enum', label: 'Upgrade to', values: M.CATEGORY_KEYS },
  amount: { type: 'number', label: 'Amount', required: true, min: 0 },
  payment_date: { type: 'date', label: 'Payment date', required: true },
  payment_reference: { type: 'text', label: 'Receipt / reference number', max: 60 },
  status_note: { type: 'text', label: 'Note', max: 2000 },
  membership_number: { type: 'text', label: 'New membership number', max: 30 },
};

// Renews or upgrades a member with a payment taken outside the website (cash
// at an event, a bank slip handed in), verified straight away. Inside a transaction.
async function recordPayment(client, member, values, settings, userId) {
  if (member.category === 'LT') throw validationError('Lifetime members do not pay renewals.');
  const pending = (await client.query("SELECT 1 FROM renewal_requests WHERE member_id = $1 AND status = 'pending'", [member.id])).rows[0];
  if (pending) throw validationError('This member has a renewal waiting for verification. Verify or reject it first.');

  const request = {
    // An upgrade names its category (Lifetime if left out); applyRenewal checks it's allowed.
    kind: values.kind, from_category: member.category, to_category: values.kind === 'upgrade' ? values.to_category || 'LT' : member.category,
  };
  // No receipt number given: use the same style as online renewals (GM000326-2611).
  values.payment_reference = values.payment_reference || M.paymentReference(member);
  const updated = await applyRenewal(client, member, request, settings, values.membership_number);
  const row = (await client.query(
    `INSERT INTO renewal_requests (member_id, kind, from_category, to_category, amount, payment_reference, payment_date,
       status, status_note, previous_valid_until, new_valid_until, recorded_by_admin, reviewed_by, reviewed_at, previous_membership_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'verified', $8, $9, $10, true, $11, now(), $12) RETURNING *`,
    [member.id, request.kind, request.from_category, request.to_category, values.amount, values.payment_reference,
      values.payment_date, values.status_note, member.valid_until, updated.valid_until, userId,
      updated.previous_membership_number || null]
  )).rows[0];
  return { request: row, member: updated };
}

function paymentEmails(result, username) {
  sendMailInBackground(emails.renewalReviewed(result.member, result.request));
  sendMailInBackground(emails.secretaryRenewalVerified(result.member, result.request, username));
}

router.post('/members/:id/payments', form, async (req, res, next) => {
  try {
    const values = parseFields(req.body, PAYMENT_FIELDS);
    const settings = await M.loadSettings();
    const result = await withTransaction(async (client) => {
      const member = await getMember(parseId(req.params.id), client);
      if (!member) throw Object.assign(new Error('Member not found.'), { statusCode: 404 });
      return recordPayment(client, member, values, settings, req.user.id);
    });
    paymentEmails(result, req.user.username);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// Reactivates a member; with kind = renewal | upgrade (and the payment fields)
// it also records that payment, all in one step.
router.post('/members/:id/reactivate', form, async (req, res, next) => {
  try {
    const values = req.body.kind ? parseFields(req.body, PAYMENT_FIELDS) : null;
    const settings = await M.loadSettings();
    const result = await withTransaction(async (client) => {
      const row = (await client.query(
        'UPDATE members SET is_active = true, deactivated_reason = NULL, deactivated_at = NULL, updated_at = now() WHERE id = $1 RETURNING *',
        [parseId(req.params.id)]
      )).rows[0];
      if (!row) throw Object.assign(new Error('Member not found.'), { statusCode: 404 });
      return values ? recordPayment(client, row, values, settings, req.user.id) : null;
    });
    // One email to the member (reactivated, with the renewal if one was recorded) and one to the secretary.
    const member = result ? result.member : (await getMember(parseId(req.params.id)));
    const request = result ? result.request : null;
    const notify = Boolean(member.email);
    if (notify) sendMailInBackground(emails.memberReactivated(member, request));
    sendMailInBackground(emails.secretaryMemberStatus(member, { active: true, by: req.user.username, request, memberEmailed: notify }));
    res.json({ success: true, member_emailed: notify, ...(result || {}) });
  } catch (err) {
    next(err);
  }
});

// ---------- Settings ----------

router.get('/settings', async (req, res, next) => {
  try {
    const [fees, settings] = await Promise.all([M.loadFees(), M.loadSettings()]);
    res.json({ fees: Object.values(fees), bank: settings.bank, event_bank: settings.eventBank, grace_days: settings.graceDays, notice_days: settings.noticeDays, email_configured: emailConfigured() });
  } catch (err) {
    next(err);
  }
});

// Bank details and renewal settings are edited separately; a request saves
// whichever group(s) it includes.
const SETTINGS_GROUPS = {
  bank: {
    bank_name: { type: 'text', label: 'Bank', required: true, max: 100 },
    bank_account_number: { type: 'text', label: 'Account number', required: true, max: 50 },
    bank_branch: { type: 'text', label: 'Branch', required: true, max: 100 },
    bank_account_name: { type: 'text', label: 'Account name', required: true, max: 200 },
  },
  event_bank: {
    event_bank_name: { type: 'text', label: 'Bank', required: true, max: 100 },
    event_bank_account_number: { type: 'text', label: 'Account number', required: true, max: 50 },
    event_bank_branch: { type: 'text', label: 'Branch', required: true, max: 100 },
    event_bank_account_name: { type: 'text', label: 'Account name', required: true, max: 200 },
  },
  renewals: {
    membership_grace_days: { type: 'int', label: 'Grace period (days)', required: true, min: 0, max: 365 },
    membership_notice_days: { type: 'int', label: 'First reminder (days before expiry)', required: true, min: 7, max: 90 },
  },
};

router.put('/settings', form, async (req, res, next) => {
  try {
    const groups = Object.values(SETTINGS_GROUPS).filter((fields) => Object.keys(fields).some((k) => k in req.body));
    if (!groups.length) throw validationError('Nothing to save.');
    const values = Object.assign({}, ...groups.map((fields) => parseFields(req.body, fields)));
    await withTransaction(async (client) => {
      for (const [key, value] of Object.entries(values)) {
        await client.query(
          'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()',
          [key, String(value)]
        );
      }
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.put('/fees/:category', form, async (req, res, next) => {
  try {
    const category = String(req.params.category).toUpperCase();
    if (!M.CATEGORIES[category]) return notFound(res, 'Unknown category.');
    const { amount } = parseFields(req.body, { amount: { type: 'number', label: 'Fee', required: true, min: 0, max: 1000000 } });
    const row = (await pool.query('UPDATE membership_fees SET amount = $1, updated_at = now() WHERE category = $2 RETURNING *', [amount, category])).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/reminders/run', async (req, res, next) => {
  try {
    res.json(await runReminders());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
