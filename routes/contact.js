// routes/contact.js
// Messages from the website's Contact page (as on SLNA):
//
//   POST   /api/contact                          send a message (public, rate-limited)
//   Admin (staff login):
//   GET    /api/contact/admin/messages?status=new|read|replied|all&q=
//   GET    /api/contact/admin/counts?q=          counts per tab
//   GET    /api/contact/admin/overview           { new } for the menu badge
//   PATCH  /api/contact/admin/messages/:id/status   { status: new | read }
//   POST   /api/contact/admin/messages/:id/reply    { reply } emails the sender and saves the reply
//   DELETE /api/contact/admin/messages/:id
//
// Each new message is emailed to the secretary (SECRETARY_EMAIL), with
// Reply-To set to the sender. A reply sent from the admin panel is emailed to
// the sender with their message quoted, Reply-To SLICNA's contact address;
// sending again replaces the saved reply (no threads), as on SLNA.

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { parseFields, parseId, validationError } = require('../lib/crud');
const { sendMail, sendMailInBackground, emailConfigured } = require('../lib/mail');
const emails = require('../lib/contact-emails');

const router = express.Router();
const form = multer().none();

const SUBJECTS = emails.SUBJECTS;
const FIELDS = {
  name: { type: 'text', label: 'Your name', required: true, max: 200 },
  email: { type: 'text', label: 'Email', required: true, max: 255 },
  phone: { type: 'text', label: 'Phone number', required: true, max: 30 },
  subject: { type: 'enum', label: 'Topic', values: Object.keys(SUBJECTS), default: 'other' },
  message: { type: 'text', label: 'Message', required: true, max: 5000 },
};

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many messages from this device. Please try again later, or call or email us.' },
  skipFailedRequests: true,
});

router.post('/', contactLimiter, form, async (req, res, next) => {
  try {
    const v = parseFields(req.body, FIELDS);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) throw validationError('Please enter a valid email address.');
    if (!/^\+?[\d\s()-]{7,20}$/.test(v.phone)) throw validationError('Please enter a valid phone number, for example 0771234567.');
    if (v.message.trim().length < 5) throw validationError('Please write a little more in your message.');
    const row = (await pool.query(
      'INSERT INTO contact_messages (full_name, email, phone, subject, message) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [v.name.trim(), v.email.trim(), v.phone || null, v.subject, v.message.trim()]
    )).rows[0];
    sendMailInBackground(emails.secretaryNewMessage(row));
    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin ----------

const admin = express.Router();
admin.use(requireAuth);

function filters(query) {
  const where = [];
  const params = [];
  if (query.q) {
    const p = params.push('%' + String(query.q).trim() + '%');
    where.push(`(full_name ILIKE $${p} OR email ILIKE $${p} OR phone ILIKE $${p} OR message ILIKE $${p})`);
  }
  return { where, params };
}
const whereSql = (where) => (where.length ? 'WHERE ' + where.join(' AND ') : '');
const STATUS_WHERE = { new: "status = 'new'", read: "status = 'read'", replied: 'replied_at IS NOT NULL' };

admin.get('/messages', async (req, res, next) => {
  try {
    const { where, params } = filters(req.query);
    if (STATUS_WHERE[req.query.status]) where.push(STATUS_WHERE[req.query.status]);
    const rows = (await pool.query(
      `SELECT m.*, u.username AS replied_by_name FROM contact_messages m LEFT JOIN users u ON u.id = m.replied_by
       ${whereSql(where)} ORDER BY m.created_at DESC`,
      params
    )).rows;
    res.json(rows.map((r) => ({ ...r, subject_label: SUBJECTS[r.subject] || r.subject })));
  } catch (err) {
    next(err);
  }
});

admin.get('/counts', async (req, res, next) => {
  try {
    const { where, params } = filters(req.query);
    const row = (await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'new')::int AS new, count(*) FILTER (WHERE status = 'read')::int AS read,
              count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied, count(*)::int AS all
       FROM contact_messages ${whereSql(where)}`,
      params
    )).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

admin.get('/overview', async (req, res, next) => {
  try {
    res.json((await pool.query("SELECT count(*)::int AS new FROM contact_messages WHERE status = 'new'")).rows[0]);
  } catch (err) {
    next(err);
  }
});

admin.patch('/messages/:id/status', form, async (req, res, next) => {
  try {
    const { status } = parseFields(req.body, { status: { type: 'enum', label: 'Status', required: true, values: ['new', 'read'] } });
    const row = (await pool.query('UPDATE contact_messages SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [status, parseId(req.params.id)])).rows[0];
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

admin.post('/messages/:id/reply', form, async (req, res, next) => {
  try {
    const { reply } = parseFields(req.body, { reply: { type: 'text', label: 'Reply', required: true, max: 10000 } });
    const msg = (await pool.query('SELECT * FROM contact_messages WHERE id = $1', [parseId(req.params.id)])).rows[0];
    if (!msg) return res.status(404).json({ error: 'Message not found.' });
    if (!emailConfigured()) {
      return res.status(503).json({ error: 'Email sending is not set up on this server, so the reply could not be sent. Please reply from your own email to ' + msg.email + '.' });
    }
    const sent = await sendMail(emails.replyToSender(msg, reply.trim()));
    if (sent.status !== 'sent') {
      console.error('Contact reply not sent:', sent.detail);
      return res.status(502).json({ error: 'The reply email could not be sent. Please try again in a moment.' });
    }
    const row = (await pool.query(
      "UPDATE contact_messages SET admin_reply = $1, replied_at = now(), replied_by = $2, status = 'read', updated_at = now() WHERE id = $3 RETURNING *",
      [reply.trim(), req.user.id, msg.id]
    )).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

admin.delete('/messages/:id', async (req, res, next) => {
  try {
    const row = (await pool.query('DELETE FROM contact_messages WHERE id = $1 RETURNING id', [parseId(req.params.id)])).rows[0];
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.use('/admin', admin);
module.exports = router;
