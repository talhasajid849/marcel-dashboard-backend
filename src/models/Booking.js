const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    // Core Identifiers
    booking_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customer_id: {
      type: String,
      index: true,
    },
    platform_id: {
      type: String,
      index: true,
    },
    tenant_id: {
      type: String,
      default: "tenant_noosa",
    },

    // Platform & Type
    platform: {
      type: String,
      enum: ["whatsapp", "messenger", "instagram", ""],
      default: "",
      index: true,
    },
    scooter_type: {
      type: String,
      enum: ["50cc", "125cc", ""],
      default: "",
    },
    scooter_plate: {
      type: String,
      index: true,
    },

    // Dates
    start_date: String,
    end_date: String,

    // Delivery Information
    pickup_delivery: String,
    delivery_address: String,

    // Customer Information
    name: String,
    phone: {
      type: String,
      index: true,
    },
    email: String,
    address: String,
    country_of_origin: String,
    next_of_kin: String,
    next_of_kin_phone: String,

    // License Information
    licence_type: String,
    licence_photo_front_url: String,
    licence_photo_back_url: String,
    license_photo_front_url: String,
    license_photo_back_url: String,

    // Pricing
    amount_upfront: Number,
    first_week_rate: Number,
    weekly_rate: Number,
    deposit: {
      type: Number,
      default: 300,
    },
    delivery_fee: Number,

    // Payment Information
    stripe_link: String,
    stripe_session_id: {
      type: String,
      index: true,
      sparse: true,
    },
    stripe_customer_id: String,
    stripe_payment_intent_id: String,
    stripe_session_expires_at: String,
    stripe_session_expired_at: String,
    payment_status: {
      type: String,
      default: "PENDING",
      enum: ["PENDING", "UNPAID", "PAID", "REFUNDED", "EXPIRED"],
    },
    payment_received_at: String,
    refund_amount: Number,
    refund_reason: String,
    refund_at: String,
    stripe_refund_id: String,

    // Booking Status
    status: {
      type: String,
      default: "PENDING",
      enum: [
        "PENDING",
        "HELD_AWAITING_PAYMENT",
        "CONFIRMED",
        "CANCELLED",
        "COMPLETED",
        "PAYMENT_EXPIRED",
      ],
      index: true,
    },

    // Payment Reminder Tracking (add these)
    reminder_24h_sent: String,
    reminder_6h_sent: String,
    reminder_2h_sent: String,

    // Timestamps
    created_at: {
      type: String,
      default: () => new Date().toISOString(),
      index: true,
    },
    confirmed_at: String,
    released_at: String,
    updated_at: {
      type: String,
      default: () => new Date().toISOString(),
    },

    // Hold Management
    hold_expires_at: String,

    // Reminders
    reminder_1_sent: String,
    reminder_2_sent: String,
    reminder_3_sent: String,
    cancellation_sent: { type: Boolean, default: false },

    // Webhook Tracking
    last_webhook_event_id: String,
    confirmation_message_sent_at: String,

    // Follow-up
    follow_up_sent_at: String,

    // Internal Notes
    notes: String,
  },
  {
    minimize: false,
    timestamps: false,
  },
);

// Compound Indexes for Performance
bookingSchema.index({ status: 1, created_at: -1 });
bookingSchema.index({ platform: 1, status: 1 });
bookingSchema.index({ start_date: 1, end_date: 1 });
bookingSchema.index({ customer_id: 1, created_at: -1 });

// Methods
bookingSchema.methods.updateTimestamp = function () {
  this.updated_at = new Date().toISOString();
  return this;
};

// Virtual for customer display name
bookingSchema.virtual("customer_name").get(function () {
  return this.name || "Unknown Customer";
});

// Virtual for customer phone display
bookingSchema.virtual("customer_phone").get(function () {
  return this.phone || "N/A";
});

// Virtual for customer email display
bookingSchema.virtual("customer_email").get(function () {
  return this.email || "N/A";
});

// Ensure virtuals are included in JSON
bookingSchema.set("toJSON", { virtuals: true });
bookingSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
