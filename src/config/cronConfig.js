/**
 * Cron Job Configuration
 * Define all scheduled task timings here
 */

const cronConfig = {
  // Payment Reminders
  paymentReminders: {
    // Run every 15 minutes to support 1h, 2h, and final 3h payment reminders.
    schedule: '*/15 * * * *',
    enabled: process.env.ENABLE_PAYMENT_REMINDERS !== 'false',
    
    // Reminder thresholds kept for config visibility. The job uses a 3-hour hold window.
    reminderThresholds: [
      { afterHours: 1, message: 'Reminder 1 of 3' },
      { afterHours: 2, message: 'Reminder 2 of 3' },
      { afterHours: 2.75, message: 'Final reminder before expiry' },
    ],
  },

  // Hold Expiry Cleanup
  holdExpiryCleanup: {
    // Backup cleanup in case reminder processing misses an expiry.
    schedule: '*/15 * * * *',
    enabled: process.env.ENABLE_HOLD_CLEANUP !== 'false',
  },

  // Odometer Check Job
odometerCheck: {
  // Run Thursday 9AM
  schedule: '0 9 * * 4',
  enabled: process.env.ENABLE_ODOMETER_CHECK !== 'false',
},

  // Daily Stats Report (future feature)
  dailyStatsReport: {
    // Run at 9 AM every day
    schedule: '0 9 * * *',
    enabled: false,
  },
};

// Cron schedule format:
// ┌───────────── minute (0 - 59)
// │ ┌───────────── hour (0 - 23)
// │ │ ┌───────────── day of month (1 - 31)
// │ │ │ ┌───────────── month (1 - 12)
// │ │ │ │ ┌───────────── day of week (0 - 6) (Sunday to Saturday)
// │ │ │ │ │
// * * * * *

module.exports = cronConfig;
