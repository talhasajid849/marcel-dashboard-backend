/**
 * Hold Expiry Cleanup Job
 * Backup cleanup for expired unpaid booking holds.
 */

const Booking = require('../models/Booking');
const paymentReminderJob = require('./paymentReminderJob');

class HoldExpiryCleanupJob {
  constructor() {
    this.name = 'HoldExpiryCleanupJob';
    this.lastRun = null;
    this.holdsReleased = 0;
  }

  isExpired(expiryDate) {
    if (!expiryDate) return false;
    const expiry = new Date(expiryDate);
    return !Number.isNaN(expiry.getTime()) && new Date() > expiry;
  }

  async execute() {
    const startTime = Date.now();
    console.log(`\n🔄 [${this.name}] Starting at ${new Date().toISOString()}`);

    try {
      const bookingsWithHolds = await Booking.find({
        status: 'HELD_AWAITING_PAYMENT',
        hold_expires_at: { $exists: true, $nin: [null, ''] },
      });

      console.log(`📋 Found ${bookingsWithHolds.length} bookings with holds`);

      let holdsReleased = 0;
      let scootersFreed = 0;

      for (const booking of bookingsWithHolds) {
        if (!this.isExpired(booking.hold_expires_at)) continue;

        console.log(`⏰ Releasing expired hold: ${booking.booking_id}`);
        const scooterReleased = await paymentReminderJob.expireBooking(booking);
        holdsReleased++;
        if (scooterReleased) scootersFreed++;
      }

      const duration = Date.now() - startTime;

      console.log(`\n📊 [${this.name}] Summary:`);
      console.log(`   - Holds released: ${holdsReleased}`);
      console.log(`   - Scooters freed: ${scootersFreed}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`✅ [${this.name}] Completed\n`);

      this.lastRun = new Date();
      this.holdsReleased += holdsReleased;

      return {
        success: true,
        holdsReleased,
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
      totalHoldsReleased: this.holdsReleased,
    };
  }
}

module.exports = new HoldExpiryCleanupJob();
