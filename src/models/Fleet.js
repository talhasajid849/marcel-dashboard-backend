const mongoose = require('mongoose');

const fleetSchema = new mongoose.Schema(
  {
    scooter_plate: { 
      type: String, 
      required: true, 
      unique: true, 
      index: true 
    },
    scooter_type: {
      type: String,
      enum: ['50cc', '125cc'],
      required: true,
      index: true
    },

    // Scooter Details
    model_name: String,
    color: String,
    year: Number,
    purchase_date: String,

    // Status Management
    status: {
      type: String,
      enum: ['AVAILABLE', 'HELD', 'BOOKED', 'MAINTENANCE', 'RETIRED'],
      default: 'AVAILABLE',
      index: true
    },

    // Current Booking Information
    booked_from: String,
    booked_to: String,
    booking_id: {
      type: String,
      index: true
    },
    hold_expires_at: String,

    // Maintenance
    last_service_date: String,
    next_service_due: String,
    odometer_km: Number,
    maintenance_notes: String,

    // Tracking
    total_bookings: {
      type: Number,
      default: 0
    },
    total_days_rented: {
      type: Number,
      default: 0
    },

    // Timestamps
    created_at: { 
      type: String, 
      default: () => new Date().toISOString() 
    },
    updated_at: { 
      type: String, 
      default: () => new Date().toISOString() 
    },

    // Internal Notes
    notes: String
  },
  {
    minimize: false
  }
);

// Compound Indexes
fleetSchema.index({ scooter_type: 1, status: 1 });
fleetSchema.index({ status: 1, booked_from: 1, booked_to: 1 });

// Methods
fleetSchema.methods.updateTimestamp = function() {
  this.updated_at = new Date().toISOString();
  return this;
};

fleetSchema.methods.markAvailable = function() {
  this.status = 'AVAILABLE';
  this.booked_from = '';
  this.booked_to = '';
  this.booking_id = '';
  this.hold_expires_at = '';
  this.updateTimestamp();
  return this;
};

fleetSchema.methods.markHeld = function(bookingId, startDate, endDate, holdExpiry) {
  this.status = 'HELD';
  this.booking_id = bookingId;
  this.booked_from = startDate;
  this.booked_to = endDate;
  this.hold_expires_at = holdExpiry;
  this.updateTimestamp();
  return this;
};

fleetSchema.methods.markBooked = function(bookingId, startDate, endDate) {
  this.status = 'BOOKED';
  this.booking_id = bookingId;
  this.booked_from = startDate;
  this.booked_to = endDate;
  this.hold_expires_at = '';
  this.total_bookings = (this.total_bookings || 0) + 1;
  this.updateTimestamp();
  return this;
};

module.exports = mongoose.model('FleetUnit', fleetSchema);