const mongoose = require('mongoose');

const pricingSchema = new mongoose.Schema(
  {
    first_week_rate: { type: Number, default: 200 },
    weekly_rate_50cc: { type: Number, default: 150 },
    weekly_rate_125cc: { type: Number, default: 160 },
    deposit: { type: Number, default: 300 },
    delivery_fee: { type: Number, default: 40 },
  },
  { _id: false },
);

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    businessName: { type: String, default: 'Honk Hire Co' },
    email: { type: String, default: 'contact@honkhireco.com.au' },
    phone: { type: String, default: '+61 493 654 132' },
    address: { type: String, default: 'Sunshine Coast, Queensland' },
    pricing: { type: pricingSchema, default: () => ({}) },
    whatsapp_enabled: { type: Boolean, default: true },
    messenger_enabled: { type: Boolean, default: false },
    instagram_enabled: { type: Boolean, default: false },
    email_notifications: { type: Boolean, default: true },
    sms_notifications: { type: Boolean, default: false },
    booking_alerts: { type: Boolean, default: true },
    payment_alerts: { type: Boolean, default: true },
    created_at: { type: String, default: () => new Date().toISOString() },
    updated_at: { type: String, default: () => new Date().toISOString() },
  },
  { minimize: false },
);

module.exports = mongoose.model('Setting', settingsSchema);
