// db/run-reminders.js
// Sends due membership renewal reminders. Schedule it to run once a day
// (e.g. a Railway cron service, like SLNA's nightly backup):
//
//   npm run reminders

const pool = require('./pool');
const { runReminders } = require('../lib/reminders');

runReminders()
  .then((summary) => {
    console.log(`[reminders] checked ${summary.checked} members: ${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed.`);
    summary.details.forEach((d) => console.log(`  ${d.membership_number} ${d.kind}: ${d.status}${d.detail ? ' (' + d.detail + ')' : ''}`));
  })
  .catch((err) => {
    console.error('[reminders] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
