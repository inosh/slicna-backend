// lib/mail.js
// Sends email through Resend's HTTP API. Until RESEND_API_KEY is set (or when
// EMAIL_ENABLED=false) nothing is sent: messages are logged and reported as
// "skipped", so the rest of the flow (and the admin's "copy link" options)
// still works.

require('dotenv').config();

function emailConfigured() {
  return process.env.EMAIL_ENABLED !== 'false' && Boolean(process.env.RESEND_API_KEY);
}

// Resolves to { status: 'sent' | 'skipped' | 'failed', detail }. Never throws.
async function sendMail({ to, subject, text }) {
  if (!to) return { status: 'skipped', detail: 'No email address' };
  if (!emailConfigured()) {
    console.log(`[mail skipped: email not configured] to=${to} subject="${subject}"`);
    return { status: 'skipped', detail: 'Email sending is not configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'SLICNA <noreply@slicna.lk>',
        to: [to],
        subject,
        text: text + '\n\n--\nSri Lanka Intensive Care Nurses Association (SLICNA)\nslicna2022@gmail.com',
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
  sendMail(message).then((r) => {
    if (r.status === 'failed') console.error('Email failed:', message.subject, r.detail);
  });
}

module.exports = { sendMail, sendMailInBackground, emailConfigured };
