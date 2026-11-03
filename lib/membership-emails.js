// lib/membership-emails.js
// Plain-text emails for the membership flow.

const { CATEGORIES } = require('./membership');

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
    under_review: 'is now being reviewed.',
    more_info_required: 'needs more information before we can continue.',
    rejected: 'could not be approved.',
    pending: 'has been received and is waiting for review.',
  }[app.status];
  return {
    to: app.email,
    subject: `Update on your SLICNA membership application (${app.reference_number})`,
    text: `Dear ${app.name_with_initials},

Your membership application (${app.reference_number}) ${intro}
${app.status_note ? `\nMessage from SLICNA:\n${app.status_note}\n` : ''}
You can check your application at any time at ${statusPage}.`,
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

We have received your ${request.kind === 'upgrade' ? 'upgrade to Lifetime Membership' : 'membership renewal'} and payment slip (reference ${request.payment_reference}).

We will verify the payment and confirm by email.`,
  };
}

function renewalReviewed(member, request) {
  if (request.status === 'verified') {
    return {
      to: member.email,
      subject: request.kind === 'upgrade' ? 'You are now a SLICNA Lifetime member' : 'SLICNA membership renewed',
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

module.exports = { applicationReceived, applicationStatusChanged, renewalReminder, renewalSubmitted, renewalReviewed };
