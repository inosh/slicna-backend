// routes/membership-admin.js
// Admin membership endpoints, all under /api/membership/admin and all
// requiring a staff login:
//
//   GET    /overview                         counts for the dashboard
//   GET    /next-number?category=GM           suggested membership number
//   Applications
//   GET    /applications?status=&category=&q=
//   GET    /applications/:id                  full details + recommending-member check
//   PATCH  /applications/:id/status           review; approving creates the member
//   DELETE /applications/:id                  delete (not approved ones) and its files
//   GET    /applications/:id/files/:kind      photo | receipt | endorsement (private)
//   Members
//   GET    /members?state=&category=&q=        directory with computed state
//   GET    /members/export.csv
//   GET    /members/:id                       details, renewal history, reminders
//   POST   /members                           add a member manually (optional photo)
//   PUT    /members/:id                       edit details (optional new photo)
//   POST   /members/:id/deactivate | /reactivate
//   GET    /members/:id/photo
//   GET    /members/:id/id-application.pdf    ID card application form
//   POST   /members/:id/id-application        mark the ID application as created
//   POST   /members/:id/renewal-link          new renewal link (optionally emailed)
//   POST   /members/:id/payments              record a payment (cash / bank) directly
//   Renewals
//   GET    /renewals?status=
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
const { privateUpload, uploadedKey, discardUploads, deletePrivateFile, sendPrivateFile, PRIVATE_ROOT } = require('../lib/private-files');
const { sendMail, sendMailInBackground, emailConfigured } = require('../lib/mail');
const { runReminders } = require('../lib/reminders');
const { writeIdApplicationPdf } = require('../lib/id-application-pdf');
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
  const value = String(number || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!value) throw validationError('Membership number is required.');
  if (!value.startsWith(category)) throw validationError(`A ${M.CATEGORIES[category]} number must start with "${category}".`);
  const taken = (await client.query(
    "SELECT id FROM members WHERE regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g') = $1 AND id IS DISTINCT FROM $2",
    [M.compactNumber(value), exceptMemberId]
  )).rows[0];
  if (taken) throw validationError(`Membership number ${value} is already in use.`);
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
    const members = (await pool.query('SELECT category, valid_until, is_active FROM members')).rows;
    const states = { active: 0, renewal_due: 0, grace: 0, lapsed: 0, deactivated: 0 };
    members.forEach((m) => { states[M.memberState(m, settings)] += 1; });
    res.json({
      applications: Object.fromEntries(apps.map((a) => [a.status, a.n])),
      pending_renewals: renewals,
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

const APP_STATUSES = ['pending', 'under_review', 'more_info_required', 'approved', 'rejected'];

router.get('/applications', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (APP_STATUSES.includes(req.query.status)) where.push(`status = $${params.push(req.query.status)}`);
    if (M.CATEGORIES[req.query.category]) where.push(`category = $${params.push(req.query.category)}`);
    if (req.query.q) {
      const p = params.push('%' + String(req.query.q).trim() + '%');
      where.push(`(full_name ILIKE $${p} OR name_with_initials ILIKE $${p} OR nic_number ILIKE $${p} OR reference_number ILIKE $${p} OR email ILIKE $${p})`);
    }
    const rows = (await pool.query(
      `SELECT id, reference_number, category, status, title, name_with_initials, full_name, nic_number, email, mobile,
              current_working_place, payment_amount, created_at, updated_at
       FROM membership_applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE status WHEN 'pending' THEN 1 WHEN 'under_review' THEN 2 WHEN 'more_info_required' THEN 3 ELSE 4 END, created_at DESC`,
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

    // For GM/OM: does the recommending LT number belong to a Lifetime member?
    let endorser_check = null;
    if (app.endorser_membership_number && app.category !== 'PM') {
      let wanted = M.compactNumber(app.endorser_membership_number);
      if (!wanted.startsWith('LT')) wanted = 'LT' + wanted;
      const lt = (await pool.query(
        "SELECT name_with_initials, membership_number, category, valid_until, is_active FROM members WHERE regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g') = $1",
        [wanted]
      )).rows[0];
      endorser_check = lt
        ? { found: true, is_lifetime: lt.category === 'LT', active: lt.is_active, name: lt.name_with_initials, membership_number: lt.membership_number }
        : { found: false };
    }
    const member = (await pool.query('SELECT id, membership_number, valid_until FROM members WHERE application_id = $1', [app.id])).rows[0] || null;
    const reviewer = app.reviewed_by ? (await pool.query('SELECT username FROM users WHERE id = $1', [app.reviewed_by])).rows[0] : null;
    res.json({ ...app, endorser_check, member, reviewed_by_name: reviewer ? reviewer.username : null });
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
        // Annual memberships start on the date the admin confirms (the form
        // defaults it to the day the application was submitted). Lifetime
        // memberships don't expire, so they simply start on approval.
        const submittedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date(current.created_at));
        const joinedOn = current.category === 'LT' ? M.today() : values.joined_on || submittedOn;
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
    [app.photo_key, app.receipt_key, app.endorsement_key].forEach(deletePrivateFile);
    fs.rm(path.join(PRIVATE_ROOT, 'membership', 'applications', app.reference_number), { recursive: true, force: true }, () => {});
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const FILE_KINDS = { photo: 'photo_key', receipt: 'receipt_key', endorsement: 'endorsement_key' };

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

// ---------- Members ----------

const STATES = Object.keys(M.STATE_LABELS);

async function listMembers(query) {
  const settings = await M.loadSettings();
  const where = [];
  const params = [];
  if (M.CATEGORIES[query.category]) where.push(`category = $${params.push(query.category)}`);
  if (query.q) {
    const p = params.push('%' + String(query.q).trim() + '%');
    where.push(`(full_name ILIKE $${p} OR name_with_initials ILIKE $${p} OR nic_number ILIKE $${p} OR membership_number ILIKE $${p} OR email ILIKE $${p} OR mobile ILIKE $${p})`);
  }
  const rows = (await pool.query(
    `SELECT * FROM members ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, membership_number`,
    params
  )).rows;
  const pending = new Set((await pool.query("SELECT member_id FROM renewal_requests WHERE status = 'pending'")).rows.map((r) => r.member_id));
  let members = rows.map((m) => withState(m, settings, pending));
  if (query.state === 'pending_renewal') members = members.filter((m) => m.has_pending_renewal);
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

router.get('/members/export.csv', async (req, res, next) => {
  try {
    const members = await listMembers(req.query);
    const cols = [
      ['Membership number', 'membership_number'], ['Category', (m) => M.CATEGORIES[m.category]], ['Status', 'state_label'],
      ['Title', 'title'], ['Name with initials', 'name_with_initials'], ['Full name', 'full_name'], ['NIC', 'nic_number'],
      ['Date of birth', 'date_of_birth'], ['Sex', 'sex'], ['Email', 'email'], ['Mobile', 'mobile'], ['WhatsApp', 'whatsapp'],
      ['Working place', 'current_working_place'], ['Designation', 'designation'], ['Joined on', 'joined_on'],
      ['Valid until', (m) => m.valid_until || 'Lifetime'], ['Source', 'source'],
    ];
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
    };
    const csv = [cols.map(([h]) => h).join(','), ...members.map((m) => cols.map(([, k]) => cell(typeof k === 'function' ? k(m) : m[k])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="slicna-members-${M.today()}.csv"`);
    res.send('﻿' + csv);
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
    const app = member.application_id
      ? (await pool.query('SELECT id, reference_number FROM membership_applications WHERE id = $1', [member.application_id])).rows[0]
      : null;
    const pending = new Set(renewals.filter((r) => r.status === 'pending').map(() => member.id));
    res.json({
      ...withState(member, settings, pending),
      has_photo: Boolean(member.photo_key),
      grace_ends: member.valid_until ? M.addDays(member.valid_until, settings.graceDays) : null,
      application: app,
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

async function memberValues(client, body, existingId = null) {
  const values = parseFields(body, MEMBER_FIELDS);
  values.nic_number = M.normaliseNic(values.nic_number);
  if (!M.isValidNic(values.nic_number)) throw validationError('Please enter a valid NIC number (9 digits with V or X, or 12 digits).');
  values.mobile = M.checkPhone(values.mobile, 'mobile', 'Mobile');
  values.whatsapp = M.checkPhone(values.whatsapp, 'phone', 'WhatsApp');
  values.membership_number = await checkMembershipNumber(client, values.membership_number, values.category, existingId);
  if (values.category === 'LT') values.valid_until = null;
  else if (!values.valid_until) values.valid_until = M.addYear(values.joined_on);
  const sameNic = (await client.query('SELECT membership_number FROM members WHERE upper(nic_number) = $1 AND id IS DISTINCT FROM $2', [values.nic_number, existingId])).rows[0];
  if (sameNic) throw validationError(`Another member already has this NIC (${sameNic.membership_number}).`);
  return values;
}

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
        const key = `membership/members/${row.id}/${path.basename(file.path)}`;
        const dest = path.join(PRIVATE_ROOT, key);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(file.path, dest);
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
      const values = await memberValues(client, req.body, id);
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
      'UPDATE members SET is_active = false, deactivated_reason = $1, deactivated_at = now(), updated_at = now() WHERE id = $2 RETURNING id',
      [reason, parseId(req.params.id)]
    )).rows[0];
    if (!row) return notFound(res, 'Member not found.');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/members/:id/reactivate', async (req, res, next) => {
  try {
    const row = (await pool.query(
      'UPDATE members SET is_active = true, deactivated_reason = NULL, deactivated_at = NULL, updated_at = now() WHERE id = $1 RETURNING id',
      [parseId(req.params.id)]
    )).rows[0];
    if (!row) return notFound(res, 'Member not found.');
    res.json({ success: true });
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

router.get('/members/:id/id-application.pdf', async (req, res, next) => {
  try {
    const member = await getMember(parseId(req.params.id));
    if (!member) return notFound(res, 'Member not found.');
    const app = member.application_id ? (await pool.query('SELECT * FROM membership_applications WHERE id = $1', [member.application_id])).rows[0] : null;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${M.compactNumber(member.membership_number)}-id-application.pdf"`);
    writeIdApplicationPdf(res, member, app);
  } catch (err) {
    next(err);
  }
});

router.post('/members/:id/id-application', async (req, res, next) => {
  try {
    const row = (await pool.query(
      'UPDATE members SET id_application_created_at = now(), updated_at = now() WHERE id = $1 RETURNING id_application_created_at',
      [parseId(req.params.id)]
    )).rows[0];
    if (!row) return notFound(res, 'Member not found.');
    res.json(row);
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
async function applyRenewal(client, member, request, settings, upgradeNumber) {
  const updates = {};
  if (request.kind === 'upgrade') {
    updates.category = 'LT';
    updates.valid_until = null;
    updates.membership_number = upgradeNumber
      ? await checkMembershipNumber(client, upgradeNumber, 'LT', member.id)
      : await M.suggestMembershipNumber('LT', M.today(), client);
  } else {
    updates.valid_until = M.renewedValidUntil(member, settings);
  }
  ['email', 'mobile', 'current_working_place'].forEach((k) => { if (request[k]) updates[k] = request[k]; });
  const cols = Object.keys(updates);
  const updated = (await client.query(
    `UPDATE members SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
    [...Object.values(updates), member.id]
  )).rows[0];
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
  membership_number: { type: 'text', label: 'New Lifetime membership number', max: 30 },
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
        `UPDATE renewal_requests SET status = $1, status_note = $2, new_valid_until = $3, reviewed_by = $4, reviewed_at = now()
         WHERE id = $5 RETURNING *`,
        [values.status, values.status_note, newValidUntil, req.user.id, current.id]
      )).rows[0];
      return { request, member };
    });

    sendMailInBackground(emails.renewalReviewed(member, request));
    res.json({ request, member });
  } catch (err) {
    next(err);
  }
});

const PAYMENT_FIELDS = {
  kind: { type: 'enum', label: 'Payment for', required: true, values: ['renewal', 'upgrade'] },
  amount: { type: 'number', label: 'Amount', required: true, min: 0 },
  payment_date: { type: 'date', label: 'Payment date', required: true },
  payment_reference: { type: 'text', label: 'Receipt / reference number', required: true, max: 60 },
  status_note: { type: 'text', label: 'Note', max: 2000 },
  membership_number: { type: 'text', label: 'New Lifetime membership number', max: 30 },
};

// Records a payment taken outside the website (cash at an event, a bank slip
// handed in) and applies it immediately.
router.post('/members/:id/payments', form, async (req, res, next) => {
  try {
    const values = parseFields(req.body, PAYMENT_FIELDS);
    const settings = await M.loadSettings();
    const result = await withTransaction(async (client) => {
      const member = await getMember(parseId(req.params.id), client);
      if (!member) throw Object.assign(new Error('Member not found.'), { statusCode: 404 });
      if (member.category === 'LT') throw validationError('Lifetime members do not pay renewals.');
      const pending = (await client.query("SELECT 1 FROM renewal_requests WHERE member_id = $1 AND status = 'pending'", [member.id])).rows[0];
      if (pending) throw validationError('This member has a renewal waiting for verification. Verify or reject it first.');

      const request = {
        kind: values.kind, from_category: member.category, to_category: values.kind === 'upgrade' ? 'LT' : member.category,
      };
      const updated = await applyRenewal(client, member, request, settings, values.membership_number);
      const row = (await client.query(
        `INSERT INTO renewal_requests (member_id, kind, from_category, to_category, amount, payment_reference, payment_date,
           status, status_note, previous_valid_until, new_valid_until, recorded_by_admin, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'verified', $8, $9, $10, true, $11, now()) RETURNING *`,
        [member.id, request.kind, request.from_category, request.to_category, values.amount, values.payment_reference,
          values.payment_date, values.status_note, member.valid_until, updated.valid_until, req.user.id]
      )).rows[0];
      return { request: row, member: updated };
    });
    sendMailInBackground(emails.renewalReviewed(result.member, result.request));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ---------- Settings ----------

router.get('/settings', async (req, res, next) => {
  try {
    const [fees, settings] = await Promise.all([M.loadFees(), M.loadSettings()]);
    res.json({ fees: Object.values(fees), bank: settings.bank, grace_days: settings.graceDays, notice_days: settings.noticeDays, email_configured: emailConfigured() });
  } catch (err) {
    next(err);
  }
});

const SETTINGS_FIELDS = {
  bank_name: { type: 'text', label: 'Bank', required: true, max: 100 },
  bank_account_number: { type: 'text', label: 'Account number', required: true, max: 50 },
  bank_branch: { type: 'text', label: 'Branch', required: true, max: 100 },
  bank_account_name: { type: 'text', label: 'Account name', required: true, max: 200 },
  membership_grace_days: { type: 'int', label: 'Grace period (days)', required: true, min: 0, max: 365 },
  membership_notice_days: { type: 'int', label: 'First reminder (days before expiry)', required: true, min: 7, max: 90 },
};

router.put('/settings', form, async (req, res, next) => {
  try {
    const values = parseFields(req.body, SETTINGS_FIELDS);
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
