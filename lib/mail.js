// lib/mail.js
// Sends email through Resend's HTTP API. Until RESEND_API_KEY is set (or when
// EMAIL_ENABLED=false) nothing is sent: messages are logged and reported as
// "skipped", so the rest of the flow (and the admin's "copy link" options)
// still works.
//
// SECRETARY_EMAIL (one address or a comma-separated list) gets notifications
// of new and approved membership applications. Its first address and
// SECRETARY_CONTACT_NO are the contact details given to applicants.

require('dotenv').config();

const SECRETARY_EMAILS = (process.env.SECRETARY_EMAIL || '').split(',').map((e) => e.trim()).filter(Boolean);
const site = () => (process.env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '');

// "0713385768" -> "071 338 5768"; anything else is shown as entered.
function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 && digits.startsWith('0') ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : String(value || '');
}

// Where applicants should reply or call.
function contactDetails() {
  const phone = (process.env.SECRETARY_CONTACT_NO || '').trim();
  return {
    email: SECRETARY_EMAILS[0] || 'slicna2022@gmail.com',
    phone: phone.replace(/[^\d+]/g, ''),
    phone_display: formatPhone(phone),
  };
}

// Link to a section of the admin panel (it asks for a login first if needed).
const adminUrl = (section) => `${site()}/pages/admin.html#${section}`;

function emailConfigured() {
  return process.env.EMAIL_ENABLED !== 'false' && Boolean(process.env.RESEND_API_KEY);
}

// Resolves to { status: 'sent' | 'skipped' | 'failed', detail }. Never throws.
// `to` is one address or a list.
// replyTo (optional): where the recipient's "Reply" goes (e.g. the sender of a contact message).
async function sendMail({ to, subject, text, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { status: 'skipped', detail: 'No email address' };
  if (!emailConfigured()) {
    console.log(`[mail skipped: email not configured] to=${recipients.join(',')} subject="${subject}"`);
    return { status: 'skipped', detail: 'Email sending is not configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'SLICNA <noreply@slicna.lk>',
        to: recipients,
        subject,
        ...(replyTo ? { reply_to: replyTo } : {}),
        text: text + `\n\n--\nSri Lanka Intensive Care Nurses Association (SLICNA)\n${contactDetails().email}`,
      }),
    });
    if (!res.ok) return { status: 'failed', detail: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { status: 'sent', detail: null };
  } catch (err) {
    return { status: 'failed', detail: err.message };
  }
}

// Fire-and-forget for emails that shouldn't hold up a response.
function sendMailInBackground(message) {
  if (!message) return;
  sendMail(message).then((r) => {
    if (r.status === 'failed') console.error('Email failed:', message.subject, r.detail);
  });
}

module.exports = { sendMail, sendMailInBackground, emailConfigured, SECRETARY_EMAILS, contactDetails, formatPhone, adminUrl };
