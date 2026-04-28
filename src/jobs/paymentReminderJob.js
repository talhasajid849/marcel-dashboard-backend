/**
 * Payment Reminder Job
 * Sends three payment reminders during the 3-hour payment hold window.
 */

const Booking = require('../models/Booking');
const Fleet = require('../models/Fleet');
const platformMessenger = require('../services/platformMessenger');
const stripeService = require('../services/stripeService');

const HOLD_DURATION_HOURS = Number(process.env.PAYMENT_HOLD_HOURS || 3);

class PaymentReminderJob {
  constructor() {
    this.name = 'PaymentReminderJob';
    this.lastRun = null;
    this.remindersSent = 0;
    this.expiredBookings = 0;
  }

  getHoldWindow(booking) {
    const expiry = new Date(booking.hold_expires_at);
    if (Number.isNaN(expiry.getTime())) return null;

    const start = new Date(expiry.getTime() - HOLD_DURATION_HOURS * 60 * 60 * 1000);
    const now = new Date();

    return {
      expiry,
      start,
      now,
      elapsedHours: (now - start) / (1000 * 60 * 60),
      remainingMinutes: Math.max(0, Math.ceil((expiry - now) / (1000 * 60))),
      expired: now >= expiry,
    };
  }

  getDueReminder(booking, elapsedHours) {
    const reminders = [
      { field: 'reminder_1_sent', number: 1, afterHours: 1 },
      { field: 'reminder_2_sent', number: 2, afterHours: 2 },
      { field: 'reminder_3_sent', number: 3, afterHours: 2.75 },
    ];

    return reminders
      .filter((reminder) => elapsedHours >= reminder.afterHours && !booking[reminder.field])
      .sort((a, b) => b.afterHours - a.afterHours)[0];
  }

  async ensureHoldWindow(booking) {
    if (booking.hold_expires_at) return false;

    const now = new Date();
    booking.hold_expires_at = new Date(now.getTime() + HOLD_DURATION_HOURS * 60 * 60 * 1000).toISOString();
    booking.reminder_1_sent = booking.reminder_1_sent || '';
    booking.reminder_2_sent = booking.reminder_2_sent || '';
    booking.reminder_3_sent = booking.reminder_3_sent || '';
    booking.updated_at = now.toISOString();
    await booking.save();

    console.warn(`Payment reminder repair: added missing hold window for ${booking.booking_id}; reminders start now.`);
    return true;
  }

  buildReminderMessage(booking, reminder, remainingMinutes) {
    const weeklyRate = booking.weekly_rate || (booking.scooter_type === '125cc' ? 160 : 150);
    const deposit = booking.deposit || 300;
    const deliveryFee = booking.delivery_fee || (booking.pickup_delivery === 'delivery' ? 40 : 0);
    const upfrontAmount = booking.amount_upfront || (weeklyRate + deposit + deliveryFee);
    const finalLine = reminder.number === 3
      ? 'This is the final reminder before the hold expires.'
      : 'The scooter is only held for this payment window.';

    return [
      `Payment reminder ${reminder.number}/3 for booking ${booking.booking_id}.`,
      `Your upfront payment is $${upfrontAmount}: $${weeklyRate} first week + $${deposit} refundable deposit${deliveryFee ? ` + $${deliveryFee} delivery` : ''}.`,
      `After that it is $${weeklyRate} per week while you have the scooter.`,
      `Time left before this hold expires: about ${remainingMinutes} minutes.`,
      `Payment link: ${booking.stripe_link}`,
      finalLine,
    ].join('\n\n');
  }

  async sendReminder(booking, reminder, remainingMinutes) {
    if (!booking.platform_id) {
      console.warn(`Payment reminder skipped (${booking.booking_id}): missing platform_id`);
      return false;
    }

    if (!booking.stripe_link) {
      console.warn(`Payment reminder skipped (${booking.booking_id}): missing stripe_link`);
      return false;
    }

    const message = this.buildReminderMessage(booking, reminder, remainingMinutes);

    try {
      await platformMessenger.sendMessage(booking.platform || 'whatsapp', booking.platform_id, message, {
        booking_id: booking.booking_id,
      });

      booking[reminder.field] = new Date().toISOString();
      booking.updated_at = new Date().toISOString();
      await booking.save();

      console.log(`✅ Payment reminder ${reminder.number}/3 sent: ${booking.booking_id}`);
      return true;
    } catch (error) {
      console.error(`❌ Payment reminder failed (${booking.booking_id}):`, error.message);
      return false;
    }
  }

  async releaseScooter(booking, now) {
    if (!booking.scooter_plate) return false;

    const scooter = await Fleet.findOne({ scooter_plate: booking.scooter_plate });
    if (!scooter) return false;

    if (scooter.booking_id && scooter.booking_id !== booking.booking_id) {
      return false;
    }

    scooter.markAvailable();
    scooter.updated_at = now;
    await scooter.save();
    return true;
  }

  async expireBooking(booking) {
    const now = new Date().toISOString();

    if (booking.stripe_session_id && !booking.stripe_session_expired_at) {
      const expiredSession = await stripeService.expireCheckoutSession(booking.stripe_session_id);
      if (expiredSession) {
        booking.stripe_session_expired_at = now;
      }
    }

    booking.status = 'PAYMENT_EXPIRED';
    booking.payment_status = 'EXPIRED';
    booking.released_at = now;
    booking.updated_at = now;
    await booking.save();

    const scooterReleased = await this.releaseScooter(booking, now);

    if (booking.platform_id) {
      try {
        await platformMessenger.sendMessage(
          booking.platform || 'whatsapp',
          booking.platform_id,
          `The 3-hour payment window for booking ${booking.booking_id} has expired, so the booking has been cancelled and the payment link is no longer active. The scooter is available again. Message us if you would like to start a new booking.`,
          { booking_id: booking.booking_id }
        );
      } catch (error) {
        console.error(`⚠️ Expiry message failed (${booking.booking_id}):`, error.message);
      }
    }

    console.log(`⏰ Booking expired after unpaid hold: ${booking.booking_id}. Scooter released: ${scooterReleased}`);
    return scooterReleased;
  }

  async execute() {
    const startTime = Date.now();
    console.log(`\n🔄 [${this.name}] Starting at ${new Date().toISOString()}`);

    try {
      const bookings = await Booking.find({
        status: 'HELD_AWAITING_PAYMENT',
        payment_status: { $ne: 'PAID' },
        stripe_link: { $exists: true, $nin: [null, ''] },
      });

      console.log(`📋 Found ${bookings.length} bookings awaiting payment`);

      let remindersSent = 0;
      let expiredBookings = 0;
      let scootersFreed = 0;
      let repairedHolds = 0;

      for (const booking of bookings) {
        const repaired = await this.ensureHoldWindow(booking);
        if (repaired) repairedHolds++;

        const window = this.getHoldWindow(booking);
        if (!window) continue;

        if (window.expired) {
          const released = await this.expireBooking(booking);
          expiredBookings++;
          if (released) scootersFreed++;
          continue;
        }

        const reminder = this.getDueReminder(booking, window.elapsedHours);
        if (!reminder) continue;

        const sent = await this.sendReminder(booking, reminder, window.remainingMinutes);
        if (sent) remindersSent++;
      }

      const duration = Date.now() - startTime;

      console.log(`\n📊 [${this.name}] Summary:`);
      console.log(`   - Missing hold windows repaired: ${repairedHolds}`);
      console.log(`   - Reminders sent: ${remindersSent}`);
      console.log(`   - Expired bookings: ${expiredBookings}`);
      console.log(`   - Scooters freed: ${scootersFreed}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`✅ [${this.name}] Completed\n`);

      this.lastRun = new Date();
      this.remindersSent += remindersSent;
      this.expiredBookings += expiredBookings;

      return {
        success: true,
        remindersSent,
        expiredBookings,
        scootersFreed,
        duration,
      };
    } catch (error) {
      console.error(`❌ [${this.name}] Error:`, error.message);
      console.error(error.stack);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  getStats() {
    return {
      name: this.name,
      lastRun: this.lastRun,
      totalRemindersSent: this.remindersSent,
      totalExpiredBookings: this.expiredBookings,
    };
  }
}

module.exports = new PaymentReminderJob();
