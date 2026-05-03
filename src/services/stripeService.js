'use strict';

/**
 * Stripe Service
 *
 * Flow:
 * 1. Customer gets ONE checkout link
 * 2. First charge = deposit + first week + delivery (saves card)
 * 3. After payment → Stripe Subscription created automatically
 * 4. Stripe charges weekly rate every week — no manual links needed
 */

const https = require('https');
const pricingService = require('./pricingService');

class StripeService {
  constructor() {
    this.secretKey = process.env.STRIPE_SECRET_KEY || '';
  }

  getCheckoutRedirectBaseUrl() {
    return (
      process.env.STRIPE_REDIRECT_URL ||
      process.env.FRONTEND_URL ||
      process.env.PUBLIC_URL ||
      'https://honkhireco.com.au'
    ).replace(/\/$/, '');
  }

  // ── Low level Stripe API call ─────────────────────────────────────────────

  stripeRequest(method, path, params = {}) {
    return new Promise((resolve, reject) => {
      const body = this._encode(params);
      const buf  = Buffer.from(body);

      const req = https.request({
        hostname: 'api.stripe.com',
        path,
        method,
        headers: {
          Authorization:   `Bearer ${this.secretKey}`,
          'Content-Type':  'application/x-www-form-urlencoded',
          'Content-Length': buf.length,
        },
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed);
          } catch (e) {
            reject(new Error('Stripe parse error: ' + data.slice(0, 200)));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Stripe timeout')); });
      req.write(buf);
      req.end();
    });
  }

  // Recursively encode object to URL params (handles nested objects/arrays)
  _encode(obj, prefix = '') {
    return Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => {
        const key = prefix ? `${prefix}[${k}]` : k;
        if (typeof v === 'object' && !Array.isArray(v)) {
          return this._encode(v, key);
        }
        return `${encodeURIComponent(key)}=${encodeURIComponent(v)}`;
      })
      .join('&');
  }

  // ── Step 1: Create upfront checkout link ─────────────────────────────────
  // Charges: deposit + first week + delivery
  // Saves card for future auto-charges

  async createUpfrontPaymentLink(booking) {
    if (!this.secretKey) {
      console.error('❌ STRIPE_SECRET_KEY not set');
      return null;
    }

    const pricing = await pricingService.getPricing();
    const quote = pricingService.quoteForBooking(booking, pricing);
    const firstWeekRate = quote.firstWeekRate;
    const weeklyRate = quote.weeklyRate;
    const deposit = quote.deposit;
    const deliveryFee = quote.deliveryFee;
    const upfront = quote.amountUpfront;
    const amountCents = Math.round(upfront * 100);
    const holdHours = Number(process.env.PAYMENT_HOLD_HOURS || 3);
    const expiresAt = Math.floor((Date.now() + holdHours * 60 * 60 * 1000) / 1000);

    const desc = [
      `${booking.scooter_type} Scooter - First Week AUD ${firstWeekRate}`,
      `Refundable Deposit AUD ${deposit}`,
      deliveryFee ? `Delivery AUD ${deliveryFee}` : null,
    ].filter(Boolean).join(' + ');

    try {
      const session = await this.stripeRequest('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        customer_creation: 'always',               // Creates Stripe customer (needed for subscription)
        'payment_intent_data[setup_future_usage]': 'off_session', // Saves card for weekly charges
        'line_items[0][price_data][currency]': pricingService.STRIPE_CURRENCY,
        'line_items[0][price_data][unit_amount]': amountCents,
        'line_items[0][price_data][product_data][name]': desc,
        'line_items[0][quantity]': 1,
        'metadata[booking_id]':     booking.booking_id,
        'metadata[payment_type]':   'upfront',
        'metadata[first_week_rate]': firstWeekRate,
        'metadata[weekly_rate]':    weeklyRate,
        'metadata[scooter_type]':   booking.scooter_type,
        'metadata[pickup_delivery]':booking.pickup_delivery || 'pickup',
        'metadata[start_date]':     booking.start_date || '',
        'metadata[end_date]':       booking.end_date   || '',
        expires_at: expiresAt,
        success_url: `${this.getCheckoutRedirectBaseUrl()}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${this.getCheckoutRedirectBaseUrl()}/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
      });

      if (!session?.url) {
        console.error('❌ No URL in Stripe response', session);
        return null;
      }

      console.log('✅ Upfront checkout created:', {
        bookingId: booking.booking_id,
        amount: upfront,
        sessionId: session.id,
      });

      // Save session ID to booking
      const Booking = require('../models/Booking');
      await Booking.findOneAndUpdate(
        { booking_id: booking.booking_id },
        {
          $set: {
            stripe_link:       session.url,
            stripe_session_id: session.id,
            stripe_session_expires_at: session.expires_at
              ? new Date(session.expires_at * 1000).toISOString()
              : new Date(expiresAt * 1000).toISOString(),
            amount_upfront:    upfront,
            first_week_rate:   firstWeekRate,
            weekly_rate:       weeklyRate,
            deposit:           deposit,
            delivery_fee:      deliveryFee,
            updated_at:        new Date().toISOString(),
          },
        }
      );

      return { url: session.url, sessionId: session.id };
    } catch (err) {
      console.error('❌ Stripe upfront link error:', err.message);
      return null;
    }
  }

  async expireCheckoutSession(sessionId) {
    if (!this.secretKey || !sessionId) return null;

    try {
      const session = await this.stripeRequest(
        'POST',
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
        {}
      );
      console.log('✅ Stripe checkout session expired:', sessionId);
      return session;
    } catch (err) {
      console.error('⚠️ Stripe checkout session expiry failed:', err.message);
      return null;
    }
  }

  // ── Step 2: After upfront payment — create auto-recurring subscription ────
  // Called from webhook after checkout.session.completed

  async createWeeklySubscription(stripeCustomerId, paymentMethodId, booking) {
    if (!this.secretKey) return null;

    try {
      const pricing = await pricingService.getPricing();
      const quote = pricingService.quoteForBooking(booking, pricing);
      if (quote.totalWeeks <= 1) {
        console.log('ℹ️  Weekly subscription skipped for one-week booking:', booking.booking_id);
        return null;
      }
      const weeklyRate =
        Number(booking.weekly_rate) ||
        quote.weeklyRate;
      const amountCents = Math.round(weeklyRate * 100);

      // Billing starts 1 week from hire start (or 7 days from now if no start date).
      // For future bookings, use a trial so Stripe does not try to invoice before
      // the first rental week has already been paid upfront.
      const startDate    = booking.start_date ? new Date(booking.start_date) : new Date();
      const billingStart = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      const anchorTs     = Math.floor(billingStart.getTime() / 1000);
      const nowTs        = Math.floor(Date.now() / 1000);
      const startsInFuture = anchorTs > nowTs + 300;

      const params = {
        customer:                 stripeCustomerId,
        default_payment_method:   paymentMethodId,
        'items[0][price_data][currency]':              pricingService.STRIPE_CURRENCY,
        'items[0][price_data][unit_amount]':           amountCents,
        'items[0][price_data][recurring][interval]':   'week',
        'items[0][price_data][product_data][name]':    `${booking.scooter_type} Weekly Hire`,
        proration_behavior:       'none',
        collection_method:        'charge_automatically',
        'metadata[booking_id]':   booking.booking_id,
        'metadata[scooter_type]': booking.scooter_type,
      };

      if (startsInFuture) {
        params.trial_end = anchorTs;
      }

      const subscription = await this.stripeRequest('POST', '/v1/subscriptions', params);

      console.log('✅ Stripe weekly subscription created:', subscription.id);
      return subscription;
    } catch (err) {
      console.error('❌ Stripe subscription error:', err.message);
      return null;
    }
  }

  async createWeeklyPaymentLink(subscription, weekNumber) {
    if (!this.secretKey) {
      console.error('âŒ STRIPE_SECRET_KEY not set');
      return null;
    }

    const payment = subscription.weekly_payments.find((p) => p.week_number === weekNumber);
    if (!payment) return null;

    try {
      const session = await this.stripeRequest('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        customer: subscription.stripe_customer_id || undefined,
        'line_items[0][price_data][currency]': pricingService.STRIPE_CURRENCY,
        'line_items[0][price_data][unit_amount]': Math.round(payment.amount * 100),
        'line_items[0][price_data][product_data][name]': `${subscription.scooter_type} Weekly Hire - Week ${weekNumber}`,
        'line_items[0][quantity]': 1,
        'metadata[payment_type]': 'weekly',
        'metadata[subscription_id]': subscription.subscription_id,
        'metadata[booking_id]': subscription.booking_id,
        'metadata[week_number]': weekNumber,
        success_url: `${this.getCheckoutRedirectBaseUrl()}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${this.getCheckoutRedirectBaseUrl()}/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
      });

      if (!session?.url) return null;

      payment.stripe_session_id = session.id;
      payment.stripe_link = session.url;
      subscription.updated_at = new Date().toISOString();
      await subscription.save();

      console.log('âœ… Weekly checkout link created:', {
        subscriptionId: subscription.subscription_id,
        weekNumber,
        sessionId: session.id,
      });

      return { url: session.url, sessionId: session.id };
    } catch (err) {
      console.error('âŒ Stripe weekly link error:', err.message);
      return null;
    }
  }

  // ── Retrieve PaymentIntent to get saved payment method ───────────────────

  async getPaymentIntent(paymentIntentId) {
    try {
      return await this.stripeRequest('GET', `/v1/payment_intents/${paymentIntentId}`, {});
    } catch (err) {
      console.error('❌ Get PaymentIntent error:', err.message);
      return null;
    }
  }

  // ── Cancel a Stripe Subscription ─────────────────────────────────────────

  async getCheckoutSession(sessionId) {
    try {
      return await this.stripeRequest('GET', `/v1/checkout/sessions/${sessionId}`, {});
    } catch (err) {
      console.error('Get Checkout Session error:', err.message);
      return null;
    }
  }

  async cancelSubscription(stripeSubscriptionId) {
    try {
      return await this.stripeRequest('DELETE', `/v1/subscriptions/${stripeSubscriptionId}`, {});
    } catch (err) {
      console.error('❌ Cancel subscription error:', err.message);
      return null;
    }
  }

  // ── Pause (pause collection) ──────────────────────────────────────────────

  async pauseSubscription(stripeSubscriptionId) {
    try {
      return await this.stripeRequest('POST', `/v1/subscriptions/${stripeSubscriptionId}`, {
        'pause_collection[behavior]': 'void',
      });
    } catch (err) {
      console.error('❌ Pause subscription error:', err.message);
      return null;
    }
  }

  async resumeSubscription(stripeSubscriptionId) {
    try {
      return await this.stripeRequest('POST', `/v1/subscriptions/${stripeSubscriptionId}`, {
        pause_collection: '',   // Empty string clears it
      });
    } catch (err) {
      console.error('❌ Resume subscription error:', err.message);
      return null;
    }
  }

  // ── Refund deposit ────────────────────────────────────────────────────────

  async refundDeposit(paymentIntentId, depositAmountCents) {
    try {
      const refund = await this.stripeRequest('POST', '/v1/refunds', {
        payment_intent: paymentIntentId,
        amount:         depositAmountCents,
        reason:         'requested_by_customer',
      });
      console.log('✅ Deposit refund created:', refund.id);
      return refund;
    } catch (err) {
      console.error('❌ Refund error:', err.message);
      return null;
    }
  }

  // ── Pricing helpers ───────────────────────────────────────────────────────

  calculatePricing(scooterType, pickupOrDelivery) {
    return pricingService.quote(scooterType, pickupOrDelivery);
  }
}

module.exports = new StripeService();
