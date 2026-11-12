// lib/contact-emails.js
// Emails for messages sent from the Contact page.

const { SECRETARY_EMAILS, contactDetails, adminUrl } = require('./mail');

// Topics on the Contact form (key -> label), in step with pages/contact.html.
const SUBJECTS = {
  membership: 'Membership',
  cpd: 'CPD programmes',
  partnership: 'Partnership or sponsorship',
  media: 'Media',
  other: 'Something else',
};

const when = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Colombo' });

// To the secretary for each new message. "Reply" in their email program goes to the sender.
function secretaryNewMessage(msg) {
  if (!SECRETARY_EMAILS.length) return null;
  return {
    to: SECRETARY_EMAILS,
    replyTo: msg.email,
    subject: `New message from the website: ${SUBJECTS[msg.subject] || 'General'} (${msg.full_name})`,
    text: `A message was sent from the Contact page on ${when(msg.created_at)}.

From: ${msg.full_name}
Email: ${msg.email}${msg.phone ? `
Phone: ${msg.phone}` : ''}
Topic: ${SUBJECTS[msg.subject] || msg.subject}

${msg.message}

Reply from the admin panel (Contact messages), or simply reply to this email:
${adminUrl('contact')}`,
  };
}

// The admin's reply to the sender, with their message quoted underneath (as on SLNA).
// Their own reply comes back to SLICNA's contact address.
function replyToSender(msg, reply) {
  const quoted = String(msg.message).split('\n').map((line) => `> ${line}`).join('\n');
  return {
    to: msg.email,
    replyTo: contactDetails().email,
    subject: `Re: Your message to SLICNA (${SUBJECTS[msg.subject] || 'General'})`,
    text: `Dear ${msg.full_name},

${reply}

---
On ${when(msg.created_at)}, you wrote:
${quoted}

Sri Lanka Intensive Care Nurses Association`,
  };
}

module.exports = { SUBJECTS, secretaryNewMessage, replyToSender };
