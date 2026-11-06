// lib/event-emails.js
// Plain-text emails for CPD event registrations.

const fmt = (dateStr) => (dateStr
  ? new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  : '');
const money = (n) => 'LKR ' + Number(n).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function registrationReceived(reg) {
  return {
    to: reg.email,
    subject: `SLICNA event registration received (${reg.reference_number})`,
    text: `Dear ${reg.full_name},

Thank you for registering for "${reg.event_title}" on ${fmt(reg.event_date)}.

Your registration reference is ${reg.reference_number}.${Number(reg.amount_due) > 0 ? `
Event fee: ${money(reg.amount_due)}. We will check your payment slip.` : ''}

Your registration is waiting for confirmation by SLICNA. We will email you again once it has been reviewed.

Sri Lanka Intensive Care Nurses Association`,
  };
}

function registrationReviewed(reg) {
  if (reg.status === 'confirmed') {
    return {
      to: reg.email,
      subject: `Your registration is confirmed: ${reg.event_title}`,
      text: `Dear ${reg.full_name},

Your registration for "${reg.event_title}" on ${fmt(reg.event_date)} is confirmed (reference ${reg.reference_number}).${reg.status_note ? `

${reg.status_note}` : ''}

Your certificate will be issued in the name "${reg.certificate_name}". We look forward to seeing you.

Sri Lanka Intensive Care Nurses Association`,
    };
  }
  return {
    to: reg.email,
    subject: `About your registration: ${reg.event_title}`,
    text: `Dear ${reg.full_name},

We could not confirm your registration for "${reg.event_title}" (reference ${reg.reference_number}).

Reason: ${reg.status_note}

If you have questions, please reply to this email or call 071 338 5768.

Sri Lanka Intensive Care Nurses Association`,
  };
}

module.exports = { registrationReceived, registrationReviewed };
