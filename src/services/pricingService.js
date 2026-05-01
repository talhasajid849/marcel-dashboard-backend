const Setting = require('../models/Setting');

const DEFAULT_PRICING = {
  first_week_rate: 200,
  weekly_rate_50cc: 150,
  weekly_rate_125cc: 160,
  deposit: 300,
  delivery_fee: 40,
};

let cachedPricing = { ...DEFAULT_PRICING };

function normalizePricing(pricing = {}) {
  return {
    first_week_rate: Number(pricing.first_week_rate) || DEFAULT_PRICING.first_week_rate,
    weekly_rate_50cc: Number(pricing.weekly_rate_50cc) || DEFAULT_PRICING.weekly_rate_50cc,
    weekly_rate_125cc: Number(pricing.weekly_rate_125cc) || DEFAULT_PRICING.weekly_rate_125cc,
    deposit: Number(pricing.deposit) || DEFAULT_PRICING.deposit,
    delivery_fee: Number(pricing.delivery_fee) || DEFAULT_PRICING.delivery_fee,
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
    firstWeekRate,
    weeklyRate,
    deposit,
    deliveryFee,
    amountUpfront: firstWeekRate + deposit + deliveryFee,
  };
}

module.exports = {
  DEFAULT_PRICING,
  getSettings,
  updateSettings,
  getPricing,
  getCachedPricing,
  quote,
};
