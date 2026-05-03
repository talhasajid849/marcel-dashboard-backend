/**
 * Weekly Payment Job - Sunday Payment Requests
 * Automatically sends payment links every Sunday
 */

const Subscription = require("../models/Subscription");
const subscriptionService = require("../services/subscriptionService");
const whatsappService = require("../services/whatsappService");

class WeeklyPaymentJob {
  constructor() {
    this.name = "WeeklyPaymentJob";
    this.lastRun = null;
    this.paymentsSent = 0;
    this.remindersSent = 0;
    this.escalations = 0;
  }

  /**
   * Main execution - Sunday 9AM payment requests
   */
  async execute() {
    const startTime = Date.now();
    console.log(`\n🔄 [${this.name}] Starting at ${new Date().toISOString()}`);

    try {
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0 = Sunday
      const hour = now.getHours();

      let paymentsSent = 0;
      let remindersSent = 0;
      let escalations = 0;

      // SUNDAY 9AM - Send payment requests
      if (dayOfWeek === 0 && hour >= 9) {
        const result = await this.sendWeeklyPaymentRequests();
        paymentsSent = result.sent;
      }

      // MONDAY 5PM - Send reminders for unpaid
      if (dayOfWeek === 1 && hour >= 17) {
        const result = await this.sendPaymentReminders();
        remindersSent = result.sent;
      }

      // WEDNESDAY 5PM - Send final reminders
      if (dayOfWeek === 3 && hour >= 17) {
        const result = await this.sendFinalReminders();
        remindersSent += result.sent;
      }

      // FRIDAY 12PM - Escalate to Cole
      if (dayOfWeek === 5 && hour >= 12) {
        const result = await this.escalateOverduePayments();
        escalations = result.escalated;
      }

      const duration = Date.now() - startTime;

      console.log(`\n📊 [${this.name}] Summary:`);
      console.log(`   - Payment requests sent: ${paymentsSent}`);
      console.log(`   - Reminders sent: ${remindersSent}`);
      console.log(`   - Escalations: ${escalations}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`✅ [${this.name}] Completed\n`);

      this.lastRun = new Date();
      this.paymentsSent += paymentsSent;
      this.remindersSent += remindersSent;
      this.escalations += escalations;

      return {
        success: true,
        paymentsSent,
        remindersSent,
        escalations,
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

  /**
   * Send weekly payment requests (Sunday 9AM)
   */
  async sendWeeklyPaymentRequests() {
    console.log("📅 Sending weekly payment requests...");

    const subscriptions = await subscriptionService.getPaymentsDueThisWeek();
    console.log(`📋 Found ${subscriptions.length} subscriptions due this week`);

    let sent = 0;

    for (const subscription of subscriptions) {
      try {
        // Find next unpaid week
        const nextWeek = subscription.weekly_payments.find(
          (p) => p.status === "PENDING",
        );

        if (!nextWeek) {
          console.log(
            `ℹ️  No pending weeks for ${subscription.subscription_id}`,
          );
          continue;
        }

        // Check if already sent today
        if (nextWeek.reminder_sent_at) {
          const sentDate = new Date(nextWeek.reminder_sent_at).toDateString();
          const today = new Date().toDateString();
          if (sentDate === today) {
            console.log(
              `ℹ️  Already sent today for week ${nextWeek.week_number}`,
            );
            continue;
          }
        }

        if (!subscription.auto_charge || !subscription.stripe_subscription_id) {
          const colePhone = process.env.COLE_WHATSAPP || "+61493654132";
          await whatsappService.sendMessage(
            colePhone,
            [
              "AUTO BILLING SETUP FAILED",
              `Customer: ${subscription.customer_name}`,
              `Phone: ${subscription.customer_phone}`,
              `Scooter: ${subscription.scooter_plate}`,
              `Week: ${nextWeek.week_number}`,
              `Reason: ${subscription.billing_failure_reason || "No Stripe subscription id"}`,
            ].join("\n"),
            {
              subscription_id: subscription.subscription_id,
              week_number: nextWeek.week_number,
            },
          );
          nextWeek.reminder_sent_at = new Date().toISOString();
          nextWeek.reminder_count = (nextWeek.reminder_count || 0) + 1;
          subscription.status = "PAUSED";
          subscription.billing_status = "SETUP_FAILED";
          subscription.billing_failure_reason =
            subscription.billing_failure_reason || "No Stripe subscription id";
          subscription.updated_at = new Date().toISOString();
          await subscription.save();
          console.error(
            `Auto billing not active for ${subscription.subscription_id}`,
          );
          continue;
        }

        // Send WhatsApp message
        const message = `Hey ${subscription.customer_name}, just a heads up - your weekly payment of AUD ${nextWeek.amount} will be automatically charged to your card this week. Nothing you need to do. Cheers!`;

        await whatsappService.sendMessage(
          subscription.customer_whatsapp_id,
          message,
          {
            subscription_id: subscription.subscription_id,
            week_number: nextWeek.week_number,
          },
        );

        // Update reminder timestamp
        nextWeek.reminder_sent_at = new Date().toISOString();
        nextWeek.reminder_count = (nextWeek.reminder_count || 0) + 1;
        await subscription.save();

        sent++;
        console.log(
          `✅ Payment request sent: Week ${nextWeek.week_number} - ${subscription.customer_name}`,
        );
      } catch (error) {
        console.error(
          `❌ Error sending payment for ${subscription.subscription_id}:`,
          error.message,
        );
      }
    }

    return { sent };
  }

  /**
   * Send payment reminders (Monday 5PM)
   */
  async sendPaymentReminders() {
    console.log("🔔 Sending payment reminders...");

    const subscriptions = await subscriptionService.getOverduePayments();
    console.log(`📋 Found ${subscriptions.length} overdue subscriptions`);

    let sent = 0;

    for (const subscription of subscriptions) {
      try {
        // Find overdue weeks
        const overdueWeeks = subscription.weekly_payments.filter(
          (p) => p.status === "PENDING" && new Date(p.due_date) < new Date(),
        );

        for (const week of overdueWeeks) {
          // Skip if already reminded today
          if (week.reminder_sent_at) {
            const lastReminder = new Date(week.reminder_sent_at);
            const hoursSince = (Date.now() - lastReminder) / (1000 * 60 * 60);
            if (hoursSince < 24) continue;
          }

          // Send reminder
          const message = `Hey ${subscription.customer_name}, just checking in - week ${week.week_number} payment was due ${week.due_date}. Here's the link when you're ready: ${week.stripe_link}`;

          await whatsappService.sendMessage(
            subscription.customer_whatsapp_id,
            message,
            {
              subscription_id: subscription.subscription_id,
              week_number: week.week_number,
            },
          );

          // Update reminder
          week.reminder_sent_at = new Date().toISOString();
          week.reminder_count = (week.reminder_count || 0) + 1;
          await subscription.save();

          sent++;
          console.log(
            `✅ Reminder sent: Week ${week.week_number} - ${subscription.customer_name}`,
          );
        }
      } catch (error) {
        console.error(
          `❌ Error sending reminder for ${subscription.subscription_id}:`,
          error.message,
        );
      }
    }

    return { sent };
  }

  /**
   * Send final reminders (Wednesday 5PM)
   */
  async sendFinalReminders() {
    console.log("⚠️  Sending final reminders...");

    const subscriptions = await subscriptionService.getOverduePayments();
    let sent = 0;

    for (const subscription of subscriptions) {
      try {
        const overdueWeeks = subscription.weekly_payments.filter(
          (p) => p.status === "PENDING" && new Date(p.due_date) < new Date(),
        );

        for (const week of overdueWeeks) {
          // Only send final reminder if already reminded at least once
          if (!week.reminder_sent_at || week.reminder_count < 2) continue;

          const message = `Hey ${subscription.customer_name}, we still need payment for week ${week.week_number} to keep your scooter active. Please pay by Friday or give Cole a call: ${week.stripe_link}`;

          await whatsappService.sendMessage(
            subscription.customer_whatsapp_id,
            message,
            {
              subscription_id: subscription.subscription_id,
              week_number: week.week_number,
            },
          );

          week.reminder_sent_at = new Date().toISOString();
          week.reminder_count = (week.reminder_count || 0) + 1;
          await subscription.save();

          sent++;
          console.log(
            `✅ Final reminder sent: Week ${week.week_number} - ${subscription.customer_name}`,
          );
        }
      } catch (error) {
        console.error(`❌ Error sending final reminder:`, error.message);
      }
    }

    return { sent };
  }

  /**
   * Escalate overdue payments (Friday 12PM)
   */
  async escalateOverduePayments() {
    console.log("🚨 Escalating overdue payments to Cole...");

    const subscriptions = await subscriptionService.getOverduePayments();
    let escalated = 0;

    for (const subscription of subscriptions) {
      try {
        const overdueWeeks = subscription.weekly_payments.filter(
          (p) =>
            p.status === "PENDING" &&
            new Date(p.due_date) < new Date() &&
            !p.escalated_at,
        );

        if (overdueWeeks.length === 0) continue;

        // Escalate to Cole
        const colePhone = process.env.COLE_WHATSAPP || "+61493654132";

        const weekNumbers = overdueWeeks.map((w) => w.week_number).join(", ");
        const totalOwed = overdueWeeks.reduce((sum, w) => sum + w.amount, 0);

        const escalationMsg = `⚠️ PAYMENT OVERDUE

Customer: ${subscription.customer_name}
Phone: ${subscription.customer_phone}
Scooter: ${subscription.scooter_plate}

Weeks overdue: ${weekNumbers}
Amount owed: AUD ${totalOwed}

Subscription: ${subscription.subscription_id}

Please contact customer manually.`;

        await whatsappService.sendMessage(colePhone, escalationMsg);

        // Mark weeks as escalated
        for (const week of overdueWeeks) {
          week.escalated_at = new Date().toISOString();
          week.status = "OVERDUE";
        }

        // Pause subscription
        subscription.status = "PAUSED";
        await subscription.save();

        escalated++;
        console.log(
          `✅ Escalated: ${subscription.customer_name} - AUD ${totalOwed}`,
        );
      } catch (error) {
        console.error(`❌ Error escalating:`, error.message);
      }
    }

    return { escalated };
  }

  /**
   * Get job statistics
   */
  getStats() {
    return {
      name: this.name,
      lastRun: this.lastRun,
      paymentsSent: this.paymentsSent,
      remindersSent: this.remindersSent,
      escalations: this.escalations,
    };
  }
}

module.exports = new WeeklyPaymentJob();
