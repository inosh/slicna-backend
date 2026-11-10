// lib/reminders.js
// Daily renewal reminders for annual members (GM, OM, PM). For each member it
// works out the single most urgent reminder that is due and has not been sent
// for the current membership period, sends it with a fresh renewal link, and
// logs the attempt in reminder_log. Safe to run more than once a day.
//
//   notice_30     up to 30 days before expiry (the "notice days" setting)
//   notice_7      7 days or less before expiry
//   expired       expired, now in the grace period
//   grace_ending  14 days or less left in the grace period
//   lapsed        grace period over (only within 30 days of lapsing)
//
// Members with a pending renewal, deactivated members and Lifetime members
// are skipped.

const pool = require('../db/pool');
const M = require('./membership');
const { sendMail } = require('./mail');
const emails = require('./membership-emails');

function dueReminder(member, settings, on) {
  const daysLeft = M.daysBetween(on, member.valid_until);
  const graceEnd = M.addDays(member.valid_until, settings.graceDays);
  const graceLeft = M.daysBetween(on, graceEnd);

  if (daysLeft < 0 && graceLeft < 0) return graceLeft >= -30 ? 'lapsed' : null;
  if (daysLeft < 0) return graceLeft <= 14 ? 'grace_ending' : 'expired';
  if (daysLeft <= 7) return 'notice_7';
  if (daysLeft <= settings.noticeDays) return 'notice_30';
  return null;
}

async function runReminders({ on = M.today() } = {}) {
  const settings = await M.loadSettings();
  const members = (await pool.query(
    `SELECT m.* FROM members m
     WHERE m.is_active AND m.category <> 'LT' AND m.valid_until IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM renewal_requests r WHERE r.member_id = m.id AND r.status = 'pending')`
  )).rows;

  const summary = { checked: members.length, sent: 0, skipped: 0, failed: 0, details: [] };

  for (const member of members) {
    const kind = dueReminder(member, settings, on);
    if (!kind) continue;

    const alreadySent = (await pool.query(
      "SELECT 1 FROM reminder_log WHERE member_id = $1 AND kind = $2 AND period_key = $3 AND status = 'sent'",
      [member.id, kind, member.valid_until]
    )).rows[0];
    if (alreadySent) continue;

    // Skipped attempts are logged once per day, not every run.
    const skippedToday = (await pool.query(
      "SELECT 1 FROM reminder_log WHERE member_id = $1 AND kind = $2 AND period_key = $3 AND status <> 'sent' AND created_at::date = $4::date",
      [member.id, kind, member.valid_until, on]
    )).rows[0];
    if (skippedToday) continue;

    let result;
    if (!member.email) {
      result = { status: 'skipped', detail: 'No email address on record' };
    } else {
      const token = await M.createRenewalToken(member.id);
      const graceEnd = M.addDays(member.valid_until, settings.graceDays);
      result = await sendMail(emails.renewalReminder(kind, member, M.renewalUrl(token), graceEnd));
    }

    await pool.query(
      'INSERT INTO reminder_log (member_id, kind, period_key, status, detail) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [member.id, kind, member.valid_until, result.status, result.detail]
    );
    summary[result.status] += 1;
    summary.details.push({ membership_number: member.membership_number, kind, status: result.status, detail: result.detail });
  }
  return summary;
}

module.exports = { runReminders, dueReminder };
