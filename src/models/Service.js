/**
 * Service Model - Scooter Service Records
 * Tracks all service history and scheduling
 */

const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema(
  {
    // Service identification
    service_id: { type: String, required: true, unique: true, index: true },
    
    // Scooter details
    scooter_plate: { type: String, required: true, index: true },
    scooter_type: String,
    
    // Service details
    service_type: { 
      type: String, 
      enum: ['REGULAR_2000KM', 'EMERGENCY', 'PRE_HIRE_CHECK', 'POST_HIRE_CHECK'],
      default: 'REGULAR_2000KM'
    },
    
    // Odometer readings
    odometer_at_service: Number, // km reading when service performed
    previous_service_km: Number,
    next_service_due_km: Number, // odometer + 2000
    
    // Service status
    status: {
      type: String,
      enum: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      default: 'SCHEDULED'
    },
    
    // Mechanic details
    mechanic_name: { type: String, default: 'Dave' },
    mechanic_phone: { type: String, default: '+61431398443' },
    mechanic_confirmed_at: String,
    mechanic_message_sent_at: String,
    mechanic_followup_sent_at: String,
    mechanic_escalated_at: String,
    
    // Scheduling
    scheduled_date: String,
    scheduled_time: String,
    service_location: String,
    
    // Hirer details (who had the scooter)
    hire_id: String,
    hirer_name: String,
    hirer_phone: String,
    hirer_whatsapp_id: String,
    
    // Booking reference
    booking_id: String,
    
    // Service execution
    service_started_at: String,
    service_completed_at: String,
    service_duration_minutes: Number,
    
    // Notes and issues
    service_notes: String,
    issues_found: [String],
    parts_replaced: [String],
    
    // Cost tracking
    service_cost: Number,
    parts_cost: Number,
    total_cost: Number,
    
    // Timestamps
    created_at: { type: String, default: () => new Date().toISOString() },
    updated_at: { type: String, default: () => new Date().toISOString() },
  },
  {
    minimize: false,
  }
);

// Indexes
serviceSchema.index({ scooter_plate: 1, created_at: -1 });
serviceSchema.index({ hire_id: 1 });
serviceSchema.index({ status: 1 });

module.exports = mongoose.model('Service', serviceSchema);
