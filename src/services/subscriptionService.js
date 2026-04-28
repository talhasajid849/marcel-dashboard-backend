/**
 * Subscription Service - Weekly Payment Management
 * Creates and manages subscriptions for active hires
 */

const Subscription = require('../models/Subscription');
const Hire = require('../models/Hire');
const Booking = require('../models/Booking');
const stripeService = require('./stripeService');

class SubscriptionService {
  /**
   * Create subscription from confirmed booking
   */
  async createFromBooking(booking) {
    try {
      // Check if subscription already exists
      const existing = await Subscription.findOne({ booking_id: booking.booking_id });
      if (existing) {
        console.log('ℹ️  Subscription already exists:', existing.subscription_id);
        return existing;
      }

      // Calculate total weeks
      const startDate = new Date(booking.start_date);
      const endDate = new Date(booking.end_date);
      const hasValidDates = !Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime());
      const diffDays = hasValidDates
        ? Math.max(1, Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)))
        : 7;
      const totalWeeks = Math.max(1, Math.ceil(diffDays / 7));

      // Get weekly rate
      const weeklyRate = booking.scooter_type === '50cc' ? 150 : 160;

      // Calculate amounts
      const depositAmount = 300;
      const deliveryFee = booking.delivery_fee || (booking.pickup_delivery === 'delivery' ? 40 : 0);
      const upfrontAmount = booking.amount_upfront || (weeklyRate + depositAmount + deliveryFee);
      const totalExpected = weeklyRate * totalWeeks;

      // Create subscription
      const subscription = new Subscription({
        subscription_id: 'SUB-' + Date.now(),
        hire_id: booking.hire_id || `HIRE-${booking.booking_id}`,
        booking_id: booking.booking_id,
        customer_id: booking.customer_id,

        scooter_plate: booking.scooter_plate || 'UNASSIGNED',
        scooter_type: booking.scooter_type,

        customer_name: booking.name,
        customer_phone: booking.phone,
        customer_whatsapp_id: booking.platform_id,
        customer_email: booking.email,

        weekly_rate: weeklyRate,
        deposit_amount: depositAmount,
        delivery_fee: deliveryFee,
        upfront_amount: upfrontAmount,

        start_date: booking.start_date,
        end_date: booking.end_date,
        total_weeks: totalWeeks,

        weeks_paid: 1, // First week paid upfront
        total_paid: weeklyRate, // First week amount
        total_expected: totalExpected,
        balance_due: totalExpected - weeklyRate,

        status: 'ACTIVE',
        weekly_payments: [],
      });

      // Create weekly payment records
      for (let week = 1; week <= totalWeeks; week++) {
        const weekStart = new Date(startDate);
        weekStart.setDate(weekStart.getDate() + (week - 1) * 7);

        // Due date is Sunday before the week starts
        const dueDate = new Date(weekStart);
        dueDate.setDate(dueDate.getDate() - dueDate.getDay()); // Move to Sunday

        const payment = {
          week_number: week,
          due_date: dueDate.toISOString().split('T')[0],
          amount: weeklyRate,
          status: week === 1 ? 'PAID' : 'PENDING',
          payment_method: week === 1 ? 'UPFRONT' : '',
          paid_at: week === 1 ? booking.confirmed_at || new Date().toISOString() : '',
          stripe_session_id: week === 1 ? booking.stripe_session_id : '',
        };

        subscription.weekly_payments.push(payment);
      }

      // Set next payment due (week 2's due date)
      if (totalWeeks > 1) {
        subscription.next_payment_due = subscription.weekly_payments[1].due_date;
      }

      await subscription.save();

      console.log('✅ Subscription created:', {
        subscription_id: subscription.subscription_id,
        total_weeks: totalWeeks,
        weekly_rate: weeklyRate,
        total_expected: totalExpected,
      });

      return subscription;
    } catch (error) {
      console.error('❌ Create subscription error:', error.message);
      throw error;
    }
  }

  /**
   * Get subscriptions needing payment this week
   */
  async getPaymentsDueThisWeek() {
    const today = new Date();
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - today.getDay()); // This Sunday
    const nextSunday = new Date(sunday);
    nextSunday.setDate(sunday.getDate() + 7);

    const sundayStr = sunday.toISOString().split('T')[0];
    const nextSundayStr = nextSunday.toISOString().split('T')[0];

    const subscriptions = await Subscription.find({
      status: 'ACTIVE',
      next_payment_due: { $gte: sundayStr, $lt: nextSundayStr },
    });

    return subscriptions;
  }

  /**
   * Get overdue payments
   */
  async getOverduePayments() {
    const today = new Date().toISOString().split('T')[0];

    const subscriptions = await Subscription.find({
      status: 'ACTIVE',
      next_payment_due: { $lt: today },
    });

    return subscriptions.filter((sub) => sub.hasOverduePayments());
  }

  /**
   * Request weekly payment (send Stripe link via WhatsApp)
   */
  async requestWeeklyPayment(subscription, weekNumber) {
    try {
      const payment = subscription.weekly_payments.find((p) => p.week_number === weekNumber);

      if (!payment) {
        console.error('❌ Week not found:', weekNumber);
        return null;
      }

      if (payment.status === 'PAID') {
        console.log('ℹ️  Week already paid:', weekNumber);
        return null;
      }

      // Create Stripe payment link
      const stripeResult = await stripeService.createWeeklyPaymentLink(subscription, weekNumber);

      if (!stripeResult) {
        console.error('❌ Failed to create Stripe link');
        return null;
      }

      console.log('✅ Weekly payment link created:', {
        subscription_id: subscription.subscription_id,
        week: weekNumber,
        url: stripeResult.url,
      });

      return {
        paymentLink: stripeResult.url,
        amount: payment.amount,
        dueDate: payment.due_date,
      };
    } catch (error) {
      console.error('❌ Request payment error:', error.message);
      return null;
    }
  }

  /**
   * Complete subscription (hire ended)
   */
  async completeSubscription(subscriptionId) {
    const subscription = await Subscription.findOne({ subscription_id: subscriptionId });

    if (!subscription) {
      console.error('❌ Subscription not found:', subscriptionId);
      return false;
    }

    await subscription.complete();

    // Check if all weeks are paid
    const unpaidWeeks = subscription.weekly_payments.filter((p) => p.status !== 'PAID');

    if (unpaidWeeks.length > 0) {
      console.warn('⚠️  Subscription completed with unpaid weeks:', unpaidWeeks.length);
    }

    console.log('✅ Subscription completed:', subscriptionId);
    return true;
  }

  /**
   * Calculate deposit refund amount
   */
  calculateDepositRefund(subscription) {
    // Full deposit if all weeks paid and no damage
    if (subscription.weeks_paid === subscription.total_weeks) {
      return subscription.deposit_amount;
    }

    // Partial refund if some weeks unpaid
    const unpaidWeeks = subscription.total_weeks - subscription.weeks_paid;
    const deduction = unpaidWeeks * subscription.weekly_rate;
    const refund = Math.max(0, subscription.deposit_amount - deduction);

    return refund;
  }

  /**
   * Process deposit refund
   */
  async refundDeposit(subscriptionId, amount, reason = 'Hire completed successfully') {
    const subscription = await Subscription.findOne({ subscription_id: subscriptionId });

    if (!subscription) {
      console.error('❌ Subscription not found:', subscriptionId);
      return false;
    }

    if (subscription.deposit_refunded) {
      console.log('ℹ️  Deposit already refunded');
      return false;
    }

    subscription.deposit_refunded = true;
    subscription.deposit_refund_amount = amount;
    subscription.deposit_refund_date = new Date().toISOString();
    subscription.deposit_refund_reason = reason;
    subscription.updated_at = new Date().toISOString();

    await subscription.save();

    console.log('✅ Deposit refund recorded:', {
      subscription_id: subscriptionId,
      amount,
      reason,
    });

    return true;
  }
}

module.exports = new SubscriptionService();
