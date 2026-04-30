const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    customer_id: { 
      type: String, 
      required: true, 
      unique: true, 
      index: true 
    },
    platform_id: { 
      type: String, 
      required: true, 
      unique: true, 
      index: true 
    },
    platform: {
      type: String,
      enum: ['whatsapp', 'messenger', 'instagram', ''],
      default: ''
    },

    // Basic Information
    name: String,
    full_name: String,
    phone: String,
    email: String,
    address: String,
    country_of_origin: String,

    // Emergency Contact
    next_of_kin: String,
    next_of_kin_phone: String,

    // License Information
    licence_type: String,
    licence_photo_front_url: String,
    licence_photo_back_url: String,
    license_photo_front_url: String,
    license_photo_back_url: String,

    // Customer Status
    customer_status: { 
      type: String, 
      default: 'NEW',
      enum: ['NEW', 'IN_PROGRESS', 'ACTIVE', 'INACTIVE', 'BLOCKED']
    },
    customer_tier: { 
      type: String, 
      default: 'NEW',
      enum: ['NEW', 'RETURNING', 'REGULAR', 'VIP']
    },

    // Statistics
    total_bookings: { 
      type: Number, 
      default: 0 
    },
    successful_bookings: { 
      type: Number, 
      default: 0 
    },
    total_hires: { 
      type: Number, 
      default: 0 
    },
    total_spent: {
      type: Number,
      default: 0
    },

    // Timestamps
    last_booking_at: String,
    last_contact: String,
    created_at: { 
      type: String, 
      default: () => new Date().toISOString() 
    },
    updated_at: { 
      type: String, 
      default: () => new Date().toISOString() 
    },

    // Conversation Summary
    conversation_summary: String,

    // Internal Notes
    notes: String,
    tags: [String]
  },
  {
    minimize: false
  }
);

// Indexes
customerSchema.index({ platform: 1, customer_status: 1 });
customerSchema.index({ customer_tier: 1 });
customerSchema.index({ created_at: -1 });

// Methods
customerSchema.methods.updateTimestamp = function() {
  this.updated_at = new Date().toISOString();
  return this;
};

customerSchema.methods.incrementBookings = function() {
  this.total_bookings = (this.total_bookings || 0) + 1;
  this.last_booking_at = new Date().toISOString();
  return this;
};

customerSchema.methods.updateTier = function() {
  const successful = this.successful_bookings || 0;
  if (successful >= 10) {
    this.customer_tier = 'VIP';
  } else if (successful >= 3) {
    this.customer_tier = 'REGULAR';
  } else if (successful >= 2) {
    this.customer_tier = 'RETURNING';
  } else {
    this.customer_tier = 'NEW';
  }
  return this;
};

module.exports = mongoose.model('Customer', customerSchema);
