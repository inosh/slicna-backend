// lib/membership-emails.js
// Plain-text emails for the membership flow.

const { CATEGORIES } = require('./membership');
const { SECRETARY_EMAILS, contactDetails, adminUrl } = require('./mail');

const site = () => (process.env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '');

function fmt(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function applicationReceived(app) {
  return {
    to: app.email,
    subject: `SLICNA membership application received (${app.reference_number})`,
    text: `Dear ${app.name_with_initials},

Thank you for applying for ${CATEGORIES[app.category]} of the Sri Lanka Intensive Care Nurses Association.

Your reference number is ${app.reference_number}. Please keep it: you can check your application at ${site()}/pages/membership-status.html using this number and your NIC.

We will review your application and payment and let you know the outcome.`,
  };
}

// What an applicant should do next when more information is needed or the
// application was rejected. The status page shows the same sentence, using
// SECRETARY_EMAIL and SECRETARY_CONTACT_NO.
function applicantFollowUp(app) {
  if (app.status !== 'more_info_required' && app.status !== 'rejected') return null;
  const c = contactDetails();
  const call = c.phone_display ? `, or call ${c.phone_display}` : '';
  const message = app.status === 'more_info_required'
    ? `Please reply by email to ${c.email} quoting your reference number ${app.reference_number}${call}.`
    : `If you have any questions, please email ${c.email} quoting your reference number ${app.reference_number}${call}.`;
  return { message, ...c };
}

function applicationStatusChanged(app, member) {
  const statusPage = `${site()}/pages/membership-status.html`;
  if (app.status === 'approved') {
    return {
      to: app.email,
      subject: 'Welcome to SLICNA: your membership is approved',
      text: `Dear ${app.name_with_initials},

Your application (${app.reference_number}) has been approved.

Membership number: ${member.membership_number}
Category: ${CATEGORIES[member.category]}
${member.valid_until ? `Valid until: ${fmt(member.valid_until)}` : 'Valid for life'}
${app.status_note ? `\nNote from SLICNA: ${app.status_note}\n` : ''}
Welcome to the association.`,
    };
  }
  const intro = {
    more_info_required: 'needs more information before we can continue.',
    rejected: 'could not be approved.',
    pending: 'has been received and is waiting for review.',
  }[app.status];
  const followUp = applicantFollowUp(app);
  return {
    to: app.email,
    subject: `Update on your SLICNA membership application (${app.reference_number})`,
    text: `Dear ${app.name_with_initials},

Your membership application (${app.reference_number}) ${intro}
${app.status_note ? `\nMessage from SLICNA:\n${app.status_note}\n` : ''}${followUp ? `\n${followUp.message}\n` : ''}
You can check your application at any time at ${statusPage}.`,
  };
}

const fmtTime = (value) => new Date(value).toLocaleString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Colombo',
});
const money = (n) => 'LKR ' + Number(n).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// To the secretary (SECRETARY_EMAIL) when an application is submitted. Null when no address is set.
function secretaryNewApplication(app) {
  if (!SECRETARY_EMAILS.length) return null;
  return {
    to: SECRETARY_EMAILS,
    subject: `New SLICNA membership application: ${app.reference_number} (${CATEGORIES[app.category]})`,
    text: `A new membership application was submitted on ${fmtTime(app.created_at)}.

Reference: ${app.reference_number}
Category: ${CATEGORIES[app.category]}
Applicant: ${[app.title, app.full_name].filter(Boolean).join(' ')} (${app.name_with_initials})
NIC: ${app.nic_number}
Email: ${app.email}
Mobile: ${app.mobile}
Working place: ${app.current_working_place || '-'}
Designation: ${app.designation || '-'}
Fee: ${app.payment_amount != null ? money(app.payment_amount) : '-'}, paid on ${fmt(app.payment_date) || '-'}

Review the application, photo and payment slip in the admin panel:
${adminUrl('applications')}`,
  };
}

// To the secretary when an application is approved and the member created.
function secretaryApplicationApproved(app, member, approvedBy) {
  if (!SECRETARY_EMAILS.length) return null;
  return {
    to: SECRETARY_EMAILS,
    subject: `Membership approved: ${member.membership_number} (${app.name_with_initials})`,
    text: `A membership application was approved${approvedBy ? ` by ${approvedBy}` : ''}.

Membership number: ${member.membership_number}
Category: ${CATEGORIES[member.category]}
Member since: ${fmt(member.joined_on)}
${member.valid_until ? `Valid until: ${fmt(member.valid_until)}` : 'Valid for life'}
Applicant: ${[app.title, app.full_name].filter(Boolean).join(' ')} (${app.name_with_initials})
NIC: ${app.nic_number}
Email: ${app.email}
Mobile: ${app.mobile}
Application reference: ${app.reference_number}

The ID card application can now be downloaded from the admin panel (Applications, "ID Application" tab):
${adminUrl('applications')}`,
  };
}

const REMINDER_TEXT = {
  notice: (m) => `Your ${CATEGORIES[m.category]} (${m.membership_number}) expires on ${fmt(m.valid_until)}.`,
  expired: (m, graceEnd) => `Your ${CATEGORIES[m.category]} (${m.membership_number}) expired on ${fmt(m.valid_until)}. You can still renew until ${fmt(graceEnd)} without losing your membership.`,
  grace_ending: (m, graceEnd) => `This is a final reminder: your membership (${m.membership_number}) will lapse on ${fmt(graceEnd)} unless it is renewed.`,
  lapsed: (m) => `Your membership (${m.membership_number}) has lapsed. You can renew at any time to reactivate it; your membership number stays the same.`,
};

function renewalReminder(kind, member, link, graceEnd) {
  const base = kind.startsWith('notice') ? 'notice' : kind;
  const subjects = {
    notice: 'Your SLICNA membership is due for renewal',
    expired: 'Your SLICNA membership has expired: renew now',
    grace_ending: 'Final reminder: renew your SLICNA membership',
    lapsed: 'Your SLICNA membership has lapsed',
  };
  return {
    to: member.email,
    subject: subjects[base],
    text: `Dear ${member.name_with_initials},

${REMINDER_TEXT[base](member, graceEnd)}

Renew online with your personal link (no login needed):
${link}

If you have already paid, you can ignore this message; we will confirm once your payment is verified.`,
  };
}

function renewalSubmitted(member, request) {
  return {
    to: request.email || member.email,
    subject: 'SLICNA renewal received',
    text: `Dear ${member.name_with_initials},

We have received your ${request.kind === 'upgrade' ? `upgrade to ${CATEGORIES[request.to_category]}` : 'membership renewal'} and payment slip (reference ${request.payment_reference}).

We will verify the payment and confirm by email.`,
  };
}

function renewalReviewed(member, request) {
  if (request.status === 'verified') {
    return {
      to: member.email,
      subject: request.kind === 'upgrade' ? `You are now a SLICNA ${CATEGORIES[request.to_category].replace(' Membership', '')} member` : 'SLICNA membership renewed',
      text: `Dear ${member.name_with_initials},

Your payment (reference ${request.payment_reference}) has been verified.

Membership number: ${member.membership_number}
Category: ${CATEGORIES[member.category]}
${member.valid_until ? `Valid until: ${fmt(member.valid_until)}` : 'Valid for life'}

Thank you for staying with SLICNA.`,
    };
  }
  return {
    to: request.email || member.email,
    subject: 'SLICNA renewal: action needed',
    text: `Dear ${member.name_with_initials},

We could not verify your renewal payment (reference ${request.payment_reference}).
${request.status_note ? `\nReason: ${request.status_note}\n` : ''}
Please submit it again using your renewal link, or renew from ${site()}/pages/membership-renew.html.`,
  };
}

const renewalKind = (request) => (request.kind === 'upgrade' ? `Upgrade to ${CATEGORIES[request.to_category]}` : 'Renewal');

// To the secretary when a member submits a renewal or upgrade with a payment slip.
function secretaryRenewalSubmitted(member, request) {
  if (!SECRETARY_EMAILS.length) return null;
  return {
    to: SECRETARY_EMAILS,
    subject: `Renewal received: ${member.membership_number} (${member.name_with_initials})`,
    text: `A member submitted ${request.kind === 'upgrade' ? `an upgrade to ${CATEGORIES[request.to_category]}` : 'a renewal'} with a payment slip on ${fmtTime(request.created_at)}.

Member: ${[member.title, member.full_name].filter(Boolean).join(' ')} (${member.name_with_initials})
Membership number: ${member.membership_number}
Category: ${CATEGORIES[member.category]}
Current valid until: ${member.valid_until ? fmt(member.valid_until) : 'Lifetime'}
Type: ${renewalKind(request)}
Amount: ${money(request.amount)}, paid on ${fmt(request.payment_date) || '-'}
Reference: ${request.payment_reference}

Check the payment slip and verify or reject it in the admin panel:
${adminUrl('renewals')}`,
  };
}

// To the secretary when a renewal or upgrade is verified (online or recorded by an admin).
function secretaryRenewalVerified(member, request, verifiedBy) {
  if (!SECRETARY_EMAILS.length) return null;
  return {
    to: SECRETARY_EMAILS,
    subject: `Renewal verified: ${member.membership_number} (${member.name_with_initials})`,
    text: `${request.kind === 'upgrade' ? `An upgrade to ${CATEGORIES[request.to_category]}` : 'A renewal'} was verified${verifiedBy ? ` by ${verifiedBy}` : ''}${request.recorded_by_admin ? ' (payment recorded in the admin panel)' : ''}.

Member: ${[member.title, member.full_name].filter(Boolean).join(' ')} (${member.name_with_initials})
Membership number: ${member.membership_number}${request.previous_membership_number ? ` (previously ${request.previous_membership_number}, now reserved)` : ''}
Category: ${CATEGORIES[member.category]}
${member.valid_until ? `Now valid until: ${fmt(member.valid_until)}` : 'Valid for life'}
Type: ${renewalKind(request)}
Amount: ${money(request.amount)}, paid on ${fmt(request.payment_date) || '-'}
Reference: ${request.payment_reference}

Member details: ${adminUrl('members')}`,
  };
}

module.exports = {
  applicationReceived, applicationStatusChanged, applicantFollowUp, secretaryNewApplication, secretaryApplicationApproved,
  renewalReminder, renewalSubmitted, renewalReviewed, secretaryRenewalSubmitted, secretaryRenewalVerified,
};
