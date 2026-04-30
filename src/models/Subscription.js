/**
 * Subscription Model - Weekly Payment Tracking
 * Manages weekly hire payments after upfront
 */

const mongoose = require("mongoose");

const weeklyPaymentSchema = new mongoose.Schema(
  {
    week_number: { type: Number, required: true },
    due_date: { type: String, required: true }, // ISO date string
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["PENDING", "PAID", "OVERDUE", "WAIVED"],
      default: "PENDING",
    },

    // Payment details
    stripe_session_id: String,
    stripe_link: String,
    paid_at: String,
    payment_method: String, // 'UPFRONT', 'WEEKLY_LINK', 'AUTO_CHARGE', 'MANUAL'

    // Reminders
    reminder_sent_at: String,
    reminder_count: { type: Number, default: 0 },
    escalated_at: String,

    // Notes
    notes: String,
  },
  { _id: false },
);

const subscriptionSchema = new mongoose.Schema(
  {
    // Identification
    subscription_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    hire_id: { type: String, required: true, index: true },
    booking_id: { type: String, required: true, index: true },
    customer_id: { type: String, index: true },

    // Scooter details
    scooter_plate: { type: String, required: true },
    scooter_type: { type: String, required: true },

    // Customer details
    customer_name: String,
    customer_phone: String,
    customer_whatsapp_id: String,
    customer_email: String,

    // Pricing
    weekly_rate: { type: Number, required: true }, // 150 for 50cc, 160 for 125cc
    deposit_amount: { type: Number, default: 300 },
    delivery_fee: { type: Number, default: 0 },
    upfront_amount: { type: Number, required: true }, // First week + deposit + delivery

    // Duration
    start_date: { type: String, required: true },
    end_date: { type: String, required: true },
    total_weeks: { type: Number, required: true },

    // Payment tracking
    weeks_paid: { type: Number, default: 1 }, // First week paid upfront
    total_paid: { type: Number, default: 0 },
    total_expected: { type: Number, required: true },
    balance_due: { type: Number, default: 0 },
    next_payment_due: String, // ISO date of next Sunday

    // Status
    status: {
      type: String,
      enum: ["ACTIVE", "PAUSED", "CANCELLED", "COMPLETED", "DEFAULTED"],
      default: "ACTIVE",
    },

    // Weekly payments array
    weekly_payments: [weeklyPaymentSchema],

    // Automation settings
    auto_charge: { type: Boolean, default: false },
    billing_status: {
      type: String,
      enum: [
        "PENDING_SETUP",
        "ACTIVE",
        "SETUP_FAILED",
        "PAYMENT_FAILED",
        "MANUAL",
        "CANCELLED",
      ],
      default: "PENDING_SETUP",
    },
    billing_failure_reason: { type: String, default: "" },
    billing_failed_at: { type: String, default: "" },
    last_payment_failed_at: { type: String, default: "" },
    stripe_subscription_id: { type: String, default: "" },
    stripe_customer_id: { type: String, default: "" },
    stripe_payment_intent_id: { type: String, default: "" },
    payment_method_id: String, // Stripe payment method for auto-charge

    // Deposit handling
    deposit_refunded: { type: Boolean, default: false },
    deposit_refund_amount: Number,
    deposit_refund_date: String,
    deposit_refund_reason: String,
    deposit_refund_id: String,

    // Timestamps
    created_at: { type: String, default: () => new Date().toISOString() },
    updated_at: { type: String, default: () => new Date().toISOString() },
    completed_at: String,
    cancelled_at: String,
  },
  {
    minimize: false,
  },
);

// Indexes
subscriptionSchema.index({ status: 1, next_payment_due: 1 });
subscriptionSchema.index({ customer_whatsapp_id: 1 });
subscriptionSchema.index({ scooter_plate: 1 });

// Methods

/**
 * Add a weekly payment record
 */
subscriptionSchema.methods.addWeeklyPayment = function (
  weekNumber,
  dueDate,
  amount,
) {
  this.weekly_payments.push({
    week_number: weekNumber,
    due_date: dueDate,
    amount,
    status: "PENDING",
    reminder_count: 0,
  });
  this.updated_at = new Date().toISOString();
  return this.save();
};

/**
 * Mark week as paid
 */
subscriptionSchema.methods.markWeekPaid = function (
  weekNumber,
  stripeSessionId,
  paymentMethod = "WEEKLY_LINK",
) {
  if (
    stripeSessionId &&
    this.weekly_payments.some(
      (p) => p.stripe_session_id === stripeSessionId && p.status === "PAID",
    )
  ) {
    return this.save();
  }

  const payment = this.weekly_payments.find(
    (p) => p.week_number === weekNumber,
  );

  if (payment) {
    if (payment.status === "PAID") {
      return this.save();
    }

    payment.status = "PAID";
    payment.paid_at = new Date().toISOString();
    payment.stripe_session_id = stripeSessionId;
    payment.payment_method = paymentMethod;

    this.weeks_paid = (this.weeks_paid || 0) + 1;
    this.total_paid = (this.total_paid || 0) + payment.amount;
    this.balance_due = Math.max(0, this.total_expected - this.total_paid);

    // Calculate next payment due (next Sunday)
    const nextWeek = this.weekly_payments.find(
      (p) => p.week_number === weekNumber + 1,
    );
    this.next_payment_due = nextWeek ? nextWeek.due_date : "";

    this.updated_at = new Date().toISOString();
  }

  return this.save();
};

/**
 * Mark week as overdue
 */
subscriptionSchema.methods.markWeekOverdue = function (weekNumber) {
  const payment = this.weekly_payments.find(
    (p) => p.week_number === weekNumber,
  );

  if (payment && payment.status === "PENDING") {
    payment.status = "OVERDUE";
    this.updated_at = new Date().toISOString();
  }

  return this.save();
};

/**
 * Check if subscription has overdue payments
 */
subscriptionSchema.methods.hasOverduePayments = function () {
  const today = new Date().toISOString().split("T")[0];
  return this.weekly_payments.some(
    (p) =>
      p.status === "OVERDUE" || (p.status === "PENDING" && p.due_date < today),
  );
};

/**
 * Get current week number
 */
subscriptionSchema.methods.getCurrentWeek = function () {
  const now = new Date();
  const start = new Date(this.start_date);
  const diffMs = now - start;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
};

/**
 * Complete subscription (hire ended)
 */
subscriptionSchema.methods.complete = function () {
  this.status = "COMPLETED";
  this.completed_at = new Date().toISOString();
  this.updated_at = new Date().toISOString();
  return this.save();
};

module.exports = mongoose.model("Subscription", subscriptionSchema);
