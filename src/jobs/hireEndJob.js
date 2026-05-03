'use strict';
/**
 * Hire End Job - runs daily at 8AM
 * Detects hires that have ended and processes returns.
 */

const Hire = require('../models/Hire');
const Fleet = require('../models/Fleet');
const Subscription = require('../models/Subscription');
const Booking = require('../models/Booking');
const stripeService = require('../services/stripeService');
const platformMessenger = require('../services/platformMessenger');

class HireEndJob {
  constructor() {
    this.name = 'HireEndJob';
  }

  async execute() {
    const today = new Date().toISOString().split('T')[0];
    console.log(`\n🔄 [HireEndJob] Checking hires on ${today}`);

    await this.sendStartReminders();

    const endedHires = await Hire.find({
      status: 'ACTIVE',
      hire_end_date: { $lte: today },
    });

    console.log(`📋 Found ${endedHires.length} ended hires to process`);

    for (const hire of endedHires) {
      try {
        await this.processHireEnd(hire);
      } catch (err) {
        console.error(`❌ Error processing hire end for ${hire.hire_id}:`, err.message);
      }
    }
  }

  async sendStartReminders() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const startingTomorrow = await Hire.find({
      status: 'ACTIVE',
      hire_start_date: tomorrowStr,
      start_reminder_sent: { $in: [null, ''] },
    });

    console.log(`📋 Found ${startingTomorrow.length} hires starting tomorrow`);

    for (const hire of startingTomorrow) {
      try {
        if (hire.hirer_whatsapp_id) {
          await platformMessenger.sendMessage(
            'whatsapp',
            hire.hirer_whatsapp_id,
            `Hey ${hire.hirer_name}! Just a reminder your scooter hire starts tomorrow.\n\nPlease bring your licence when you collect the scooter. Cole will be in touch today to confirm the exact time.\n\nAny questions just message here. Can't wait to get you riding! 🛵`
          );
        }

        await platformMessenger.sendMessage(
          'whatsapp',
          process.env.COLE_WHATSAPP || '+61493654132',
          `📅 HIRE STARTS TOMORROW\n\nHirer: ${hire.hirer_name}\nPhone: ${hire.hirer_phone}\nScooter: ${hire.scooter_plate}\nDate: ${hire.hire_start_date}\nBooking: ${hire.booking_id}`
        );

        hire.start_reminder_sent = new Date().toISOString();
        await hire.save();
      } catch (err) {
        console.error(`❌ Error sending hire start reminder for ${hire.hire_id}:`, err.message);
      }
    }
  }

  async processHireEnd(hire) {
    const now = new Date().toISOString();

    hire.status = 'COMPLETED';
    hire.completed_at = now;
    hire.updated_at = now;
    await hire.save();

    await Fleet.findOneAndUpdate(
      { scooter_plate: hire.scooter_plate },
      {
        $set: {
          status: 'AVAILABLE',
          booking_id: '',
          booked_from: '',
          booked_to: '',
          hold_expires_at: '',
          updated_at: now,
        },
      }
    );

    const subscription = await Subscription.findOne({ hire_id: hire.hire_id });
    if (subscription?.stripe_subscription_id) {
      await stripeService.cancelSubscription(subscription.stripe_subscription_id);
      subscription.status = 'COMPLETED';
      subscription.completed_at = now;
      subscription.updated_at = now;
      await subscription.save();
    }

    await Booking.findOneAndUpdate(
      { booking_id: hire.booking_id },
      { $set: { status: 'COMPLETED', updated_at: now } }
    );

    if (hire.hirer_whatsapp_id) {
      const bond = subscription?.deposit_amount || 300;
      await platformMessenger.sendMessage(
        'whatsapp',
        hire.hirer_whatsapp_id,
        `Hey ${hire.hirer_name}, your hire period has ended today. Thanks so much for riding with us!\n\nJust a reminder - please return the scooter to the agreed location with a full tank of 91 unleaded.\n\nOnce we confirm the bike is back in good condition, your AUD ${bond} bond will be refunded within 3-5 business days. Any questions give us a shout!`
      );
    }

    const colePhone = process.env.COLE_WHATSAPP || '+61493654132';
    await platformMessenger.sendMessage(
      'whatsapp',
      colePhone,
      `📋 HIRE ENDED\n\nHirer: ${hire.hirer_name}\nPhone: ${hire.hirer_phone}\nScooter: ${hire.scooter_plate}\nHire ID: ${hire.hire_id}\n\nScooter is now marked AVAILABLE. Please confirm return and process deposit refund.`
    );

    console.log(`✅ Hire ended: ${hire.hire_id} | Scooter ${hire.scooter_plate} -> AVAILABLE`);
  }

  getStats() {
    return { name: this.name };
  }
}

module.exports = new HireEndJob();
