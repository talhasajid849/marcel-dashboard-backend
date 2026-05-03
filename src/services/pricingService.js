const Setting = require('../models/Setting');

const DEFAULT_PRICING = {
  first_week_rate: 200,
  weekly_rate_50cc: 150,
  weekly_rate_125cc: 160,
  deposit: 300,
  delivery_fee: 40,
  booking_deposit: 30,
  bike_lock_rate: 5,
};

const PAYMENT_CURRENCY = 'AUD';
const STRIPE_CURRENCY = 'aud';

let cachedPricing = { ...DEFAULT_PRICING };

function normalizePricing(pricing = {}) {
  return {
    first_week_rate: Number(pricing.first_week_rate) || DEFAULT_PRICING.first_week_rate,
    weekly_rate_50cc: Number(pricing.weekly_rate_50cc) || DEFAULT_PRICING.weekly_rate_50cc,
    weekly_rate_125cc: Number(pricing.weekly_rate_125cc) || DEFAULT_PRICING.weekly_rate_125cc,
    deposit: Number(pricing.deposit) || DEFAULT_PRICING.deposit,
    delivery_fee: Number(pricing.delivery_fee) || DEFAULT_PRICING.delivery_fee,
    booking_deposit: Number(pricing.booking_deposit) || DEFAULT_PRICING.booking_deposit,
    bike_lock_rate: Number(pricing.bike_lock_rate) || DEFAULT_PRICING.bike_lock_rate,
  };
}

async function getSettings() {
  const settings = await Setting.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: { key: 'global', pricing: DEFAULT_PRICING } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();

  cachedPricing = normalizePricing(settings.pricing);
  return { ...settings, pricing: cachedPricing };
}

async function updateSettings(updates = {}) {
  const payload = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  if (updates.pricing) {
    payload.pricing = normalizePricing(updates.pricing);
  }

  const settings = await Setting.findOneAndUpdate(
    { key: 'global' },
    { $set: payload, $setOnInsert: { key: 'global', created_at: new Date().toISOString() } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();

  cachedPricing = normalizePricing(settings.pricing);
  return { ...settings, pricing: cachedPricing };
}

async function getPricing() {
  const settings = await getSettings();
  return settings.pricing;
}

function getCachedPricing() {
  return { ...cachedPricing };
}

function quote(scooterType, pickupOrDelivery, pricing = cachedPricing) {
  const normalized = normalizePricing(pricing);
  const weeklyRate =
    scooterType === '125cc'
      ? normalized.weekly_rate_125cc
      : normalized.weekly_rate_50cc;
  const firstWeekRate = normalized.first_week_rate;
  const deposit = normalized.deposit;
  const deliveryFee = pickupOrDelivery === 'delivery' ? normalized.delivery_fee : 0;

  return {
    currency: PAYMENT_CURRENCY,
    stripeCurrency: STRIPE_CURRENCY,
    firstWeekRate,
    weeklyRate,
    deposit,
    bond: deposit,
    bookingDeposit: normalized.booking_deposit,
    bikeLockRate: normalized.bike_lock_rate,
    deliveryFee,
    totalWeeks: 1,
    rentalTotal: firstWeekRate,
    amountUpfront: firstWeekRate + deposit + deliveryFee,
  };
}

function calculateBillableWeeks(startDate, endDate) {
  const diffDays = calculateBillableDays(startDate, endDate);
  if (!diffDays) return 1;
  return Math.max(1, Math.ceil(diffDays / 7));
}

function calculateBillableDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }

  return Math.max(
    1,
    Math.ceil((end - start) / (1000 * 60 * 60 * 24)),
  );
}

function quoteForBooking(booking = {}, pricing = cachedPricing) {
  const base = quote(booking.scooter_type, booking.pickup_delivery, pricing);
  const hasBookingDates = Boolean(booking.start_date && booking.end_date);
  const billableDays = calculateBillableDays(booking.start_date, booking.end_date);
  const totalWeeks = calculateBillableWeeks(booking.start_date, booking.end_date);
  const isShortHire = hasBookingDates && billableDays > 0 && billableDays < 14;
  const weeklyRate = isShortHire ? base.firstWeekRate : base.weeklyRate;
  const firstWeekRate = isShortHire ? base.firstWeekRate : base.weeklyRate;
  const rentalTotal =
    firstWeekRate + weeklyRate * Math.max(0, totalWeeks - 1);

  return {
    ...base,
    firstWeekRate,
    weeklyRate,
    hasBookingDates,
    billableDays,
    isShortHire,
    totalWeeks,
    rentalTotal,
    amountUpfront: firstWeekRate + base.deposit + base.deliveryFee,
  };
}

module.exports = {
  DEFAULT_PRICING,
  PAYMENT_CURRENCY,
  STRIPE_CURRENCY,
  getSettings,
  updateSettings,
  getPricing,
  getCachedPricing,
  quote,
  quoteForBooking,
  calculateBillableWeeks,
  calculateBillableDays,
};
