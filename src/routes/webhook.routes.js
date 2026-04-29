"use strict";

/**
 * Webhook Routes
 * Handles Stripe events:
 *  - checkout.session.completed   → confirm booking + create weekly subscription
 *  - invoice.payment_succeeded    → mark weekly payment paid
 *  - invoice.payment_failed       → notify Cole
 *  - customer.subscription.deleted → mark subscription cancelled
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const Booking = require("../models/Booking");
const Customer = require("../models/Customer");
const Fleet = require("../models/Fleet");
const Subscription = require("../models/Subscription");
const Hire = require("../models/Hire");
const stripeService = require("../services/stripeService");

// ── POST /api/webhook/stripe ─────────────────────────────────────────────────

function verifyStripeSignature(req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // No secret configured — allow all (dev mode)
  if (!secret) return true;

  const signature = req.get("stripe-signature") || "";

  // No signature header — this is a manual test call, allow it
  if (!signature) return true;

  const rawBody = req.rawBody;
  if (!rawBody) return false;

  const parts = Object.fromEntries(
    signature.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );

  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const actual = Buffer.from(digest);
  const expectedBuffer = Buffer.from(expected);
  return (
    actual.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actual, expectedBuffer)
  );
}

router.post("/stripe", async (req, res) => {
  if (!verifyStripeSignature(req)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid Stripe signature" });
  }

  // Respond quickly so Stripe does not retry successful deliveries.
  res.status(200).json({ received: true });

  try {
    const event = req.body;

    // Support both real Stripe format and manual test format
    const eventType = event.type;
    const object = event.data?.object || {};

    console.log(`📥 Stripe webhook: ${eventType}`);

    if (eventType === "checkout.session.completed") {
      if (object.metadata?.payment_type === "weekly") {
        await handleWeeklyCheckoutCompleted(object);
      } else {
        await handleCheckoutCompleted(object);
      }
      return;
    }

    if (eventType === "invoice.payment_succeeded") {
      await handleInvoicePaymentSucceeded(object);
      return;
    }

    if (eventType === "invoice.payment_failed") {
      await handleInvoicePaymentFailed(object);
      return;
    }

    if (eventType === "customer.subscription.deleted") {
      await handleSubscriptionDeleted(object);
      return;
    }

    // Manual test format: { session_id: '...' }
    // Manual test format: { session_id: '...' }
    if (!eventType && req.body.session_id) {
      const booking = await Booking.findOne({
        stripe_session_id: req.body.session_id,
      });
      await handleCheckoutCompleted({
        id: req.body.session_id,
        customer: booking?.stripe_customer_id || null,
        payment_intent: booking?.stripe_payment_intent_id || null,
        metadata: { booking_id: booking?.booking_id || "" },
      });
    }
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// ── checkout.session.completed ───────────────────────────────────────────────
// First payment received → confirm booking → create Stripe subscription

async function handleCheckoutCompleted(session) {
  const bookingId = session.metadata?.booking_id;
  const stripeCustomerId = session.customer;
  const paymentIntentId = session.payment_intent;
  const sessionId = session.id;

  if (!bookingId) {
    console.warn("⚠️  No booking_id in session metadata");
    return;
  }

  // Find booking
  const booking = await Booking.findOne({
    $or: [{ booking_id: bookingId }, { stripe_session_id: sessionId }],
  });

  if (!booking) {
    console.error("❌ Booking not found:", bookingId);
    return;
  }

  // Ignore duplicate webhooks
  if (booking.status === "CONFIRMED") {
    console.log("ℹ️  Already confirmed, skipping:", bookingId);
    return;
  }

  const now = new Date().toISOString();

  // 1. Confirm booking
  booking.status = "CONFIRMED";
  booking.payment_status = "PAID";
  booking.confirmed_at = now;
  booking.payment_received_at = now;
  booking.stripe_customer_id = stripeCustomerId || "";
  booking.stripe_payment_intent_id = paymentIntentId || "";
  booking.stripe_session_id = sessionId;
  booking.updated_at = now;
  await booking.save();

  console.log("✅ Booking confirmed:", bookingId);

  // 2. Mark scooter as BOOKED
  if (booking.scooter_plate) {
    await Fleet.findOneAndUpdate(
      { scooter_plate: booking.scooter_plate },
      {
        $set: {
          status: "BOOKED",
          booking_id: booking.booking_id,
          booked_from: booking.start_date,
          booked_to: booking.end_date,
          hold_expires_at: "",
          updated_at: now,
        },
      },
    );
  }

  // 3. Update customer stats
  // Update customer stats + tier
  const customer = await Customer.findOne({ customer_id: booking.customer_id });
  if (customer) {
    customer.total_bookings = (customer.total_bookings || 0) + 1;
    customer.successful_bookings = (customer.successful_bookings || 0) + 1;
    customer.total_hires = customer.successful_bookings;
    customer.total_spent =
      (customer.total_spent || 0) + (booking.amount_upfront || 0);
    customer.last_booking_at = now;
    customer.updated_at = now;

    // Update tier based on number of completed hires
    const hires = customer.successful_bookings;
    if (hires >= 10) customer.customer_tier = "VIP";
    else if (hires >= 3) customer.customer_tier = "REGULAR";
    else if (hires >= 1) customer.customer_tier = "RETURNING";
    else customer.customer_tier = "NEW";

    // Save licence photos to customer profile for future bookings
    if (booking.licence_photo_front_url)
      customer.licence_photo_front_url = booking.licence_photo_front_url;
    if (booking.licence_photo_back_url)
      customer.licence_photo_back_url = booking.licence_photo_back_url;
    if (booking.name) customer.name = booking.name;
    if (booking.phone) customer.phone = booking.phone;
    if (booking.email) customer.email = booking.email;
    if (booking.address) customer.address = booking.address;
    if (booking.country_of_origin)
      customer.country_of_origin = booking.country_of_origin;
    if (booking.next_of_kin) customer.next_of_kin = booking.next_of_kin;
    if (booking.next_of_kin_phone)
      customer.next_of_kin_phone = booking.next_of_kin_phone;
    if (booking.licence_type) customer.licence_type = booking.licence_type;

    await customer.save();

    console.log(
      `✅ Customer updated: ${customer.name} | Tier: ${customer.customer_tier} | Hires: ${hires}`,
    );
  }

  // 4. Create hire record
  await createHireRecord(booking, now);

  // 5. Create internal subscription record
  const subscriptionService = require("../services/subscriptionService");
  const localSubscription =
    await subscriptionService.createFromBooking(booking);

  // 6. Create Stripe Subscription (auto weekly charges)
  if (stripeCustomerId && paymentIntentId) {
    try {
      // Get payment method from PaymentIntent
      const pi = await stripeService.getPaymentIntent(paymentIntentId);
      const paymentMethodId = pi?.payment_method;

      if (paymentMethodId) {
        const stripeSub = await stripeService.createWeeklySubscription(
          stripeCustomerId,
          paymentMethodId,
          booking,
        );

        if (stripeSub?.id) {
          // Save Stripe subscription ID
          await Subscription.findOneAndUpdate(
            { booking_id: booking.booking_id },
            {
              $set: {
                auto_charge: true,
                stripe_subscription_id: stripeSub.id,
                stripe_customer_id:
                  stripeCustomerId ||
                  localSubscription?.stripe_customer_id ||
                  "",
                stripe_payment_intent_id:
                  paymentIntentId ||
                  localSubscription?.stripe_payment_intent_id ||
                  "",
                payment_method_id: paymentMethodId,
                updated_at: now,
              },
            },
          );
          console.log("✅ Weekly subscription active:", stripeSub.id);
        }
      } else {
        console.warn(
          "⚠️  No payment method on PaymentIntent — subscription not created",
        );
      }
    } catch (err) {
      console.error(
        "⚠️  Subscription creation error (booking still confirmed):",
        err.message,
      );
    }
  }

  // 7. Send WhatsApp confirmation
  await sendConfirmationMessage(booking);
}

async function handleWeeklyCheckoutCompleted(session) {
  const subscriptionId = session.metadata?.subscription_id;
  const weekNumber = Number(session.metadata?.week_number);

  if (!subscriptionId || !weekNumber) {
    console.warn("Weekly checkout missing subscription_id or week_number");
    return;
  }

  const subscription = await Subscription.findOne({
    subscription_id: subscriptionId,
  });
  if (!subscription) {
    console.warn("No local subscription for weekly checkout:", subscriptionId);
    return;
  }

  await subscription.markWeekPaid(weekNumber, session.id, "WEEKLY_LINK");
  console.log("Weekly checkout marked paid:", {
    subscription_id: subscriptionId,
    week_number: weekNumber,
    session_id: session.id,
  });

  if (subscription.customer_whatsapp_id) {
    try {
      const platformMessenger = require("../services/platformMessenger");
      await platformMessenger.sendMessage(
        "whatsapp",
        subscription.customer_whatsapp_id,
        `Weekly payment received - you're all sorted for week ${weekNumber}. Cheers!`,
      );
    } catch (e) {
      console.error("Weekly checkout confirmation failed:", e.message);
    }
  }
}

// ── invoice.payment_succeeded ────────────────────────────────────────────────
// Weekly auto-charge succeeded → mark week paid

async function handleInvoicePaymentSucceeded(invoice) {
  // Only handle subscription invoices (not the first upfront payment)
  if (!invoice.subscription) return;
  if (invoice.billing_reason === "subscription_create") {
    // This is the first invoice after subscription creation — ignore
    // (first payment was handled by checkout.session.completed)
    return;
  }

  const stripeSubId = invoice.subscription;
  const amountPaid = invoice.amount_paid / 100;
  const now = new Date().toISOString();

  console.log(
    `✅ Weekly payment received: $${amountPaid} for subscription ${stripeSubId}`,
  );

  // Find our subscription
  const subscription = await Subscription.findOne({
    stripe_subscription_id: stripeSubId,
  });
  if (!subscription) {
    console.warn(
      "⚠️  No local subscription for Stripe subscription:",
      stripeSubId,
    );
    return;
  }

  // Find next unpaid week and mark it paid
  const unpaidWeek = subscription.weekly_payments.find(
    (p) => p.status === "PENDING",
  );
  if (unpaidWeek) {
    await subscription.markWeekPaid(
      unpaidWeek.week_number,
      invoice.id,
      "AUTO_CHARGE",
    );
    console.log("✅ Week marked paid:", unpaidWeek.week_number);
  }

  // Send WhatsApp confirmation
  if (subscription.customer_whatsapp_id) {
    try {
      const platformMessenger = require("../services/platformMessenger");
      const msg = `Weekly payment of $${amountPaid} received — you're all sorted for this week. Cheers!`;
      await platformMessenger.sendMessage(
        "whatsapp",
        subscription.customer_whatsapp_id,
        msg,
      );
    } catch (e) {
      console.error("⚠️  WhatsApp weekly confirmation failed:", e.message);
    }
  }
}

// ── invoice.payment_failed ───────────────────────────────────────────────────
// Weekly auto-charge failed → notify Cole + customer

async function handleInvoicePaymentFailed(invoice) {
  if (!invoice.subscription) return;

  const stripeSubId = invoice.subscription;
  console.warn("⚠️  Weekly payment FAILED for subscription:", stripeSubId);

  const subscription = await Subscription.findOne({
    stripe_subscription_id: stripeSubId,
  });
  if (!subscription) return;

  // Notify Cole
  const colePhone = process.env.COLE_WHATSAPP || "+61493654132";
  try {
    const platformMessenger = require("../services/platformMessenger");

    await platformMessenger.sendMessage(
      "whatsapp",
      colePhone,
      `⚠️ PAYMENT FAILED\nCustomer: ${subscription.customer_name}\nPhone: ${subscription.customer_phone}\nScooter: ${subscription.scooter_plate}\nAmount: $${invoice.amount_due / 100}\n\nCard was declined. Please contact customer.`,
    );

    // Also message the customer
    if (subscription.customer_whatsapp_id) {
      await platformMessenger.sendMessage(
        "whatsapp",
        subscription.customer_whatsapp_id,
        `Hey ${subscription.customer_name}, your weekly payment of $${invoice.amount_due / 100} couldn't go through. Please update your card details or give Cole a call on 0493 654 132.`,
      );
    }
  } catch (e) {
    console.error("⚠️  Failed payment notification error:", e.message);
  }
}

// ── customer.subscription.deleted ───────────────────────────────────────────

async function handleSubscriptionDeleted(stripeSub) {
  const stripeSubId = stripeSub.id;
  console.log("ℹ️  Stripe subscription deleted:", stripeSubId);

  await Subscription.findOneAndUpdate(
    { stripe_subscription_id: stripeSubId },
    {
      $set: {
        status: "CANCELLED",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createHireRecord(booking, now) {
  try {
    const existing = await Hire.findOne({ booking_id: booking.booking_id });
    if (existing) return;

    if (!booking.scooter_plate) return;

    const fleet = await Fleet.findOne({ scooter_plate: booking.scooter_plate });
    const startOdo = Number(fleet?.odometer_km) || 0;

    await Hire.create({
      hire_id: `HIRE-${booking.booking_id}`,
      booking_id: booking.booking_id,
      scooter_plate: booking.scooter_plate,
      scooter_type: booking.scooter_type,
      hirer_name: booking.name || "",
      hirer_phone: booking.phone || "",
      hirer_whatsapp_id: booking.platform_id || "",
      hirer_email: booking.email || "",
      hire_start_date: booking.start_date,
      hire_end_date: booking.end_date,
      odometer_at_hire_start: startOdo,
      current_odometer: startOdo,
      next_service_due_km: startOdo + 2000,
      status: "ACTIVE",
      created_at: now,
      updated_at: now,
    });

    console.log("✅ Hire record created:", `HIRE-${booking.booking_id}`);
  } catch (err) {
    console.error("⚠️  Hire creation error:", err.message);
  }
}

async function sendConfirmationMessage(booking) {
  if (!booking.platform_id) return;

  try {
    const platformMessenger = require("../services/platformMessenger");
    const weeklyRate =
      booking.weekly_rate || (booking.scooter_type === "125cc" ? 160 : 150);
    const deposit = booking.deposit || 300;
    const deliveryFee = booking.delivery_fee || 0;
    const upfront =
      booking.amount_upfront || weeklyRate + deposit + deliveryFee;

    const msg = [
      `Payment received — you're confirmed! 🎉`,
      `${booking.scooter_type} scooter from ${booking.start_date} to ${booking.end_date}.`,
      `Upfront paid: $${upfront} (first week $${weeklyRate} + deposit $${deposit}${deliveryFee ? ` + delivery $${deliveryFee}` : ""}).`,
      `From week 2 onwards your card will be charged $${weeklyRate} automatically each week — nothing to do on your end.`,
      `The $${deposit} deposit comes back when you return the bike undamaged with a full tank.`,
      `Any questions just message here. Enjoy the ride! 🛵`,
    ].join("\n\n");

    await platformMessenger.sendMessage(
      booking.platform || "whatsapp",
      booking.platform_id,
      msg,
      { booking_id: booking.booking_id },
    );

    console.log("✅ Confirmation message sent to:", booking.platform_id);
  } catch (err) {
    console.error("⚠️  Confirmation message error:", err.message);
  }
}

// ── Booking created / other webhook endpoints ────────────────────────────────

router.post("/booking-created", async (req, res) => {
  console.log("📥 booking-created webhook:", req.body?.booking?.booking_id);
  res.json({ success: true });
});

module.exports = router;
