/**
 * Subscription Service - Weekly Payment Management
 * Creates and manages subscriptions for active hires
 */

const Subscription = require('../models/Subscription');
const Hire = require('../models/Hire');
const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const stripeService = require('./stripeService');
const pricingService = require('./pricingService');

function resolveCustomerName(booking, customer) {
  return booking?.name || customer?.name || customer?.full_name || '';
}

function resolveCustomerPhone(booking, customer) {
  return booking?.phone || customer?.phone || '';
}

function resolveCustomerEmail(booking, customer) {
  return booking?.email || customer?.email || '';
}

class SubscriptionService {
  /**
   * Create subscription from confirmed booking
   */
  async createFromBooking(booking) {
    try {
      // Check if subscription already exists
      const existing = await Subscription.findOne({ booking_id: booking.booking_id });
      const customer = booking.customer_id
        ? await Customer.findOne({ customer_id: booking.customer_id })
        : await Customer.findOne({
            platform: booking.platform,
            platform_id: booking.platform_id,
          });
      if (existing) {
        existing.customer_name =
          existing.customer_name || resolveCustomerName(booking, customer);
        existing.customer_phone =
          existing.customer_phone || resolveCustomerPhone(booking, customer);
        existing.customer_email =
          existing.customer_email || resolveCustomerEmail(booking, customer);
        existing.customer_whatsapp_id =
          existing.customer_whatsapp_id ||
          booking.platform_id ||
          customer?.platform_id ||
          '';
        existing.updated_at = new Date().toISOString();
        await existing.save();
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

      const pricing = await pricingService.getPricing();
      const quote = pricingService.quote(booking.scooter_type, booking.pickup_delivery, pricing);
      const firstWeekRate = Number(booking.first_week_rate) || quote.firstWeekRate;
      const weeklyRate = Number(booking.weekly_rate) || quote.weeklyRate;

      // Calculate amounts
      const depositAmount = Number(booking.deposit) || quote.deposit;
      const deliveryFee = Number(booking.delivery_fee) || quote.deliveryFee;
      const upfrontAmount = booking.amount_upfront || (firstWeekRate + depositAmount + deliveryFee);
      const totalExpected = firstWeekRate + weeklyRate * Math.max(0, totalWeeks - 1);

      // Create subscription
      const subscription = new Subscription({
        subscription_id: 'SUB-' + Date.now(),
        hire_id: booking.hire_id || `HIRE-${booking.booking_id}`,
        booking_id: booking.booking_id,
        customer_id: booking.customer_id,

        scooter_plate: booking.scooter_plate || 'UNASSIGNED',
        scooter_type: booking.scooter_type,

        customer_name: resolveCustomerName(booking, customer),
        customer_phone: resolveCustomerPhone(booking, customer),
        customer_whatsapp_id: booking.platform_id,
        customer_email: resolveCustomerEmail(booking, customer),

        first_week_rate: firstWeekRate,
        weekly_rate: weeklyRate,
        deposit_amount: depositAmount,
        delivery_fee: deliveryFee,
        upfront_amount: upfrontAmount,

        start_date: booking.start_date,
        end_date: booking.end_date,
        total_weeks: totalWeeks,

        weeks_paid: 1, // First week paid upfront
        total_paid: firstWeekRate, // First week amount
        total_expected: totalExpected,
        balance_due: totalExpected - firstWeekRate,

        status: 'ACTIVE',
        auto_charge: false,
        billing_status: 'PENDING_SETUP',
        stripe_customer_id: booking.stripe_customer_id || '',
        stripe_payment_intent_id: booking.stripe_payment_intent_id || '',
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
          amount: week === 1 ? firstWeekRate : weeklyRate,
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

    if (subscription.stripe_subscription_id) {
      const cancelled = await stripeService.cancelSubscription(subscription.stripe_subscription_id);
      if (!cancelled) {
        console.error('âŒ Failed to cancel Stripe subscription:', subscription.stripe_subscription_id);
        return false;
      }
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

    let paymentIntentId = subscription.stripe_payment_intent_id;

    if (!paymentIntentId) {
      const booking = await Booking.findOne({ booking_id: subscription.booking_id });
      paymentIntentId = booking?.stripe_payment_intent_id;
    }

    if (!paymentIntentId) {
      const upfrontPayment = subscription.weekly_payments.find(
        (payment) => payment.week_number === 1 && payment.stripe_session_id
      );
      const session = upfrontPayment
        ? await stripeService.getCheckoutSession(upfrontPayment.stripe_session_id)
        : null;
      paymentIntentId = session?.payment_intent;
    }

    if (!paymentIntentId) {
      console.error('No upfront Stripe payment intent stored for refund');
      return false;
    }

    const refundAmount = Math.min(Number(amount) || 0, subscription.deposit_amount || 0);
    if (refundAmount <= 0) {
      console.error('Invalid deposit refund amount:', amount);
      return false;
    }

    const stripeRefund = await stripeService.refundDeposit(
      paymentIntentId,
      Math.round(refundAmount * 100)
    );

    if (!stripeRefund?.id) {
      return false;
    }

    subscription.deposit_refunded = true;
    subscription.deposit_refund_amount = refundAmount;
    subscription.deposit_refund_date = new Date().toISOString();
    subscription.deposit_refund_reason = reason;
    subscription.deposit_refund_id = stripeRefund.id;
    subscription.stripe_payment_intent_id = paymentIntentId;
    subscription.updated_at = new Date().toISOString();

    await subscription.save();

    console.log('✅ Deposit refund recorded:', {
      subscription_id: subscriptionId,
      amount: refundAmount,
      reason,
      stripe_refund_id: stripeRefund.id,
    });

    return true;
  }
}

module.exports = new SubscriptionService();
