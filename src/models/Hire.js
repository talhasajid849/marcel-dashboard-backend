/**
 * Hire Model - Active Scooter Hires
 * Tracks odometer readings and service scheduling
 */

const mongoose = require('mongoose');

const odometerReadingSchema = new mongoose.Schema(
  {
    reading_km: { type: Number, required: true },
    reported_at: { type: String, default: () => new Date().toISOString() },
    reported_by: String, // 'HIRER' or 'SYSTEM'
    reading_method: String, // 'THURSDAY_CHECK', 'HIRE_START', 'HIRE_END', 'MANUAL'
    notes: String,
  },
  { _id: false }
);

const hireSchema = new mongoose.Schema(
  {
    // Hire identification
    hire_id: { type: String, required: true, unique: true, index: true },
    
    // Linked booking
    booking_id: { type: String, required: true, index: true },
    
    // Scooter details
    scooter_plate: { type: String, required: true, index: true },
    scooter_type: String,
    
    // Hirer details
    hirer_name: { type: String, required: true },
    hirer_phone: String,
    hirer_whatsapp_id: String, // e.g., "61412345678@c.us"
    hirer_email: String,
    
    // Hire period
    hire_start_date: String,
    hire_end_date: String,
    start_reminder_sent: String,
    
    // Odometer tracking
    odometer_at_hire_start: { type: Number, required: true },
    odometer_at_hire_end: Number,
    current_odometer: Number, // Latest reported reading
    
    // Odometer reading history
    odometer_readings: [odometerReadingSchema],
    
    // Service tracking
    next_service_due_km: { type: Number, required: true }, // hire_start + 2000
    service_due_threshold: { type: Number, default: 200 }, // Trigger at 200km before due
    
    // Weekly check tracking
    last_thursday_check: String, // ISO date of last Thursday check
    thursday_check_sent: String, // ISO date when last check message sent
    thursday_check_responded: String, // ISO date when hirer responded
    thursday_reminder_sent: String, // Friday 5pm reminder
    escalated_to_cole: String, // Saturday 12pm escalation
    
    // Service booking status
    service_needed: { type: Boolean, default: false },
    service_booking_initiated: String,
    service_scheduled: { type: Boolean, default: false },
    service_id: String, // Reference to Service record
    
    // Hire status
    status: {
      type: String,
      enum: ['ACTIVE', 'COMPLETED', 'CANCELLED'],
      default: 'ACTIVE'
    },
    
    // Completion
    completed_at: String,
    total_km_travelled: Number,
    
    // Timestamps
    created_at: { type: String, default: () => new Date().toISOString() },
    updated_at: { type: String, default: () => new Date().toISOString() },
  },
  {
    minimize: false,
  }
);

// Indexes
hireSchema.index({ scooter_plate: 1, status: 1 });
hireSchema.index({ hirer_whatsapp_id: 1 });
hireSchema.index({ status: 1, next_service_due_km: 1 });

// Method to add odometer reading
hireSchema.methods.addOdometerReading = function(reading_km, method = 'MANUAL', notes = '', reportedBy = 'HIRER') {
  const reading = Number(reading_km);
  if (!Number.isFinite(reading)) {
    throw new Error('Invalid odometer reading');
  }

  this.odometer_readings.push({
    reading_km: reading,
    reported_at: new Date().toISOString(),
    reported_by: reportedBy,
    reading_method: method,
    notes,
  });
  
  this.current_odometer = reading;
  this.updated_at = new Date().toISOString();
  
  // Check if service is needed (within 200km of due)
  if (this.next_service_due_km - reading <= this.service_due_threshold) {
    this.service_needed = true;
  }
  
  return this.save();
};

// Method to check if Thursday check is due
hireSchema.methods.isThursdayCheckDue = function() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  // Check if already done today
  if (this.last_thursday_check === today) {
    return false;
  }
  
  // Check if it's Thursday (4 = Thursday in JS, 0 = Sunday)
  return now.getDay() === 4;
};

module.exports = mongoose.model('Hire', hireSchema);
