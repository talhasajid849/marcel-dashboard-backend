/**
 * Cron Service - Main Scheduler
 * Manages all scheduled jobs.
 */

const cron = require('node-cron');
const cronConfig = require('../config/cronConfig');
const paymentReminderJob = require('../jobs/paymentReminderJob');
const holdExpiryCleanupJob = require('../jobs/holdExpiryCleanupJob');
const odometerCheckJob = require('../jobs/odometerCheckJob');
const weeklyPaymentJob = require('../jobs/weeklyPaymentJob');
const hireEndJob = require('../jobs/hireEndJob');

class CronService {
  constructor() {
    this.jobs = new Map();
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) {
      console.log('Cron service already running');
      return;
    }

    console.log('\nStarting Cron Service...');
    console.log('====================================');

    this.scheduleJob(
      'weeklyPayment',
      '0 * * * *',
      weeklyPaymentJob,
      'Weekly Payments'
    );


    if (cronConfig.paymentReminders.enabled) {
      this.scheduleJob(
        'paymentReminders',
        cronConfig.paymentReminders.schedule,
        paymentReminderJob,
        'Payment Reminders'
      );
    }

    if (cronConfig.holdExpiryCleanup.enabled) {
      this.scheduleJob(
        'holdExpiryCleanup',
        cronConfig.holdExpiryCleanup.schedule,
        holdExpiryCleanupJob,
        'Hold Expiry Cleanup'
      );
    }

    if (cronConfig.odometerCheck?.enabled !== false) {
      this.scheduleJob(
        'odometerCheck',
        cronConfig.odometerCheck.schedule,
        odometerCheckJob,
        'Odometer Check'
      );

      // Daily at 8AM
this.scheduleJob('hireEnd', '0 8 * * *', hireEndJob, 'Hire End Check');

      this.scheduleJob(
        'odometerFollowUp',
        '0 * * * *',
        odometerCheckJob,
        'Odometer Follow-ups'
      );
    }

    console.log('====================================');
    console.log(`${this.jobs.size} cron job(s) started\n`);

    this.isRunning = true;

    this.runStartupCatchup();
  }

  runStartupCatchup() {
    const catchupJobs = ['paymentReminders', 'holdExpiryCleanup'];

    setImmediate(async () => {
      for (const jobName of catchupJobs) {
        const jobData = this.jobs.get(jobName);
        if (!jobData) continue;

        try {
          console.log(`Startup catch-up running: ${jobName}`);
          await jobData.instance.execute();
        } catch (error) {
          console.error(`Startup catch-up failed (${jobName}):`, error.message);
        }
      }
    });
  }

  scheduleJob(name, schedule, instance, label) {
    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron schedule for ${name}: ${schedule}`);
    }

    const job = cron.schedule(
      schedule,
      async () => {
        try {
          await instance.execute();
        } catch (error) {
          console.error(`Cron job failed (${name}):`, error.message);
        }
      },
      {
        scheduled: true,
        timezone: process.env.TIMEZONE || 'Australia/Brisbane',
      }
    );

    this.jobs.set(name, { job, schedule, instance });
    console.log(`${label}: ${schedule}`);
  }

  stop() {
    console.log('\nStopping Cron Service...');

    this.jobs.forEach((jobData, name) => {
      jobData.job.stop();
      console.log(`Stopped: ${name}`);
    });

    this.jobs.clear();
    this.isRunning = false;

    console.log('Cron service stopped\n');
  }

  getStatus() {
    const jobs = [];

    this.jobs.forEach((jobData, name) => {
      const stats =
        typeof jobData.instance.getStats === 'function'
          ? jobData.instance.getStats()
          : {};

      jobs.push({
        name,
        schedule: jobData.schedule,
        ...stats,
      });
    });

    return {
      isRunning: this.isRunning,
      totalJobs: this.jobs.size,
      jobs,
    };
  }

  async runJob(jobName) {
    const jobData = this.jobs.get(jobName);

    if (!jobData) {
      throw new Error(`Job not found: ${jobName}`);
    }

    console.log(`Manually running job: ${jobName}`);
    return jobData.instance.execute();
  }
}

module.exports = new CronService();
