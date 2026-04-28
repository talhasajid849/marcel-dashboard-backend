/**
 * Message Model - WhatsApp Chat History
 * Stores all WhatsApp conversations
 */

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    // Message identification
    message_id: { type: String, required: true, unique: true, index: true },
    
    // Platform details
    platform: { type: String, default: 'whatsapp' },
    platform_id: { type: String, required: true, index: true }, // e.g., "61412345678@c.us"
    
    // Message content
    direction: { type: String, enum: ['INCOMING', 'OUTGOING'], required: true },
    message_type: { type: String, enum: ['text', 'image', 'document', 'audio', 'video'], default: 'text' },
    message_body: String,
    
    // Media attachments
    media_url: String,
    media_mimetype: String,
    
    // Customer reference
    customer_id: String,
    customer_name: String,
    customer_phone: String,
    
    // Booking reference (if related to booking)
    booking_id: String,
    
    // Service reference (if related to service)
    service_id: String,
    hire_id: String,
    
    // Message status
    status: { type: String, enum: ['SENT', 'DELIVERED', 'READ', 'FAILED'], default: 'SENT' },
    
    // AI context
    ai_processed: { type: Boolean, default: false },
    ai_intent: String, // 'booking_inquiry', 'odometer_reading', 'service_response', etc.
    ai_extracted_data: mongoose.Schema.Types.Mixed,
    
    // Timestamps
    sent_at: { type: String, default: () => new Date().toISOString() },
    created_at: { type: String, default: () => new Date().toISOString() },
    updated_at: { type: String, default: () => new Date().toISOString() },
  },
  {
    minimize: false,
  }
);

// Indexes for efficient querying
messageSchema.index({ platform_id: 1, created_at: -1 });
messageSchema.index({ customer_id: 1, created_at: -1 });
messageSchema.index({ booking_id: 1 });
messageSchema.index({ hire_id: 1 });

module.exports = mongoose.model('Message', messageSchema);