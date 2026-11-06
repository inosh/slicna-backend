// lib/event-emails.js
// Plain-text emails for CPD event registrations.

const { SECRETARY_EMAILS, adminUrl } = require('./mail');

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

const REGISTERED_AS = { LT: 'Lifetime member', GM: 'General member', OM: 'Ordinary member', PM: 'Partial member', NM: 'Non-member' };

// To the secretary (SECRETARY_EMAIL) for every new registration. Null when no address is set.
function secretaryNewRegistration(reg) {
  if (!SECRETARY_EMAILS.length) return null;
  const member = reg.membership_number
    ? `${reg.membership_number} (${REGISTERED_AS[reg.fee_category]}${reg.member_id ? '' : ', not in the member register: please check'})`
    : 'Non-member';
  return {
    to: SECRETARY_EMAILS,
    subject: `New event registration: ${reg.event_title} (${reg.reference_number})`,
    text: `A new registration was submitted for "${reg.event_title}" on ${fmt(reg.event_date)}.

Reference: ${reg.reference_number}
Registrant: ${reg.full_name}
Name on certificate: ${reg.certificate_name}
NIC: ${reg.nic_number}
Registered as: ${member}
Email: ${reg.email}
Mobile: ${reg.mobile}
Workplace: ${reg.workplace}
Fee: ${Number(reg.amount_due) > 0 ? `${money(reg.amount_due)}, paid by ${reg.pay_by === 'organisation' ? 'organisation' : 'individual'} on ${fmt(reg.payment_date)}` : 'Free'}

Review the registration${Number(reg.amount_due) > 0 ? ' and payment slip' : ''} in the admin panel (Registrations):
${adminUrl('registrations')}`,
  };
}

module.exports = { registrationReceived, registrationReviewed, secretaryNewRegistration };
