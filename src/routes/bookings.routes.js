const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const Fleet = require('../models/Fleet');
const Subscription = require('../models/Subscription');
const Hire = require('../models/Hire');
const emailService = require('../services/emailService');
const stripeService = require('../services/stripeService');
const pricingService = require('../services/pricingService');

const EDITABLE_BOOKING_FIELDS = [
  'customer_id',
  'platform',
  'platform_id',
  'scooter_type',
  'scooter_plate',
  'start_date',
  'end_date',
  'pickup_delivery',
  'delivery_address',
  'name',
  'phone',
  'email',
  'address',
  'country_of_origin',
  'next_of_kin',
  'next_of_kin_phone',
  'licence_type',
  'licence_photo_front_url',
  'licence_photo_back_url',
  'license_photo_front_url',
  'license_photo_back_url',
  'amount_upfront',
  'first_week_rate',
  'weekly_rate',
  'deposit',
  'delivery_fee',
  'status',
  'payment_status',
  'notes',
];

function pickEditableBookingFields(source) {
  return EDITABLE_BOOKING_FIELDS.reduce((acc, field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      acc[field] = source[field];
    }
    return acc;
  }, {});
}

function startOfDay(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  value.setHours(0, 0, 0, 0);
  return value;
}

function datesOverlap(startA, endA, startB, endB) {
  const aStart = startOfDay(startA);
  const aEnd = startOfDay(endA);
  const bStart = startOfDay(startB);
  const bEnd = startOfDay(endB);
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

function bookingBlocksDates(booking) {
  if (booking.status === 'CONFIRMED') return true;
  if (booking.status !== 'HELD_AWAITING_PAYMENT') return false;
  if (!booking.hold_expires_at) return false;
  const holdExpiresAt = new Date(booking.hold_expires_at);
  return !Number.isNaN(holdExpiresAt.getTime()) && holdExpiresAt > new Date();
}

function validateBookingDates(data) {
  if (!data.start_date || !data.end_date) return null;

  const start = startOfDay(data.start_date);
  const end = startOfDay(data.end_date);
  if (!start || !end) return 'Start date and end date must be valid dates';
  if (end < start) return 'End date cannot be before start date';

  const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) return 'Bookings must be at least 1 week';

  return null;
}

function applyBookingPricing(data, options = {}) {
  const quote = pricingService.quoteForBooking(data);
  const firstWeekRate = Number(data.first_week_rate) || quote.firstWeekRate;
  const weeklyRate = Number(data.weekly_rate) || quote.weeklyRate;
  const deposit = Number(data.deposit) || quote.deposit;
  const deliveryFee = Number(data.delivery_fee) || quote.deliveryFee;

  if (!data.first_week_rate && firstWeekRate) data.first_week_rate = firstWeekRate;
  if (!data.weekly_rate && weeklyRate) data.weekly_rate = weeklyRate;
  if (!data.deposit) data.deposit = deposit;
  data.delivery_fee = deliveryFee;
  if ((options.recalculateUpfront || !data.amount_upfront) && firstWeekRate) {
    data.amount_upfront = firstWeekRate + deposit + deliveryFee;
  }
}

async function validateScooterAvailability(data, currentBookingId = '') {
  if (!data.scooter_plate || !data.start_date || !data.end_date) return null;

  const scooter = await Fleet.findOne({ scooter_plate: data.scooter_plate }).lean();
  if (!scooter) return 'Selected scooter does not exist';
  if (['MAINTENANCE', 'RETIRED'].includes(scooter.status)) {
    return 'Selected scooter is not available for bookings';
  }

  if (data.scooter_type && scooter.scooter_type !== data.scooter_type) {
    return `Selected scooter is ${scooter.scooter_type}, not ${data.scooter_type}`;
  }

  const conflicts = await Booking.find({
    booking_id: { $ne: currentBookingId },
    scooter_plate: data.scooter_plate,
    status: { $in: ['HELD_AWAITING_PAYMENT', 'CONFIRMED'] },
    payment_status: { $ne: 'EXPIRED' },
    start_date: { $exists: true, $nin: [null, ''] },
    end_date: { $exists: true, $nin: [null, ''] },
  }).lean();

  const conflictingBooking = conflicts.find(
    (booking) =>
      bookingBlocksDates(booking) &&
      datesOverlap(data.start_date, data.end_date, booking.start_date, booking.end_date),
  );

  return conflictingBooking
    ? `Scooter ${data.scooter_plate} already has booking ${conflictingBooking.booking_id} for overlapping dates`
    : null;
}

function isActiveToday(booking) {
  return datesOverlap(new Date(), new Date(), booking.start_date, booking.end_date);
}

async function syncFleetForBooking(booking, oldScooterPlate = '') {
  if (oldScooterPlate && oldScooterPlate !== booking.scooter_plate) {
    await Fleet.findOneAndUpdate(
      {
        scooter_plate: oldScooterPlate,
        booking_id: booking.booking_id,
        status: { $nin: ['MAINTENANCE', 'RETIRED'] },
      },
      {
        $set: {
          status: 'AVAILABLE',
          booking_id: '',
          booked_from: '',
          booked_to: '',
          hold_expires_at: '',
          updated_at: new Date().toISOString(),
        },
      },
    );
  }

  if (!booking.scooter_plate) return;

  const blocksFleetNow =
    booking.status === 'CONFIRMED' && isActiveToday(booking);

  await Fleet.findOneAndUpdate(
    {
      scooter_plate: booking.scooter_plate,
      status: { $nin: ['MAINTENANCE', 'RETIRED'] },
    },
    {
      $set: {
        status: blocksFleetNow ? 'BOOKED' : 'AVAILABLE',
        booking_id: blocksFleetNow ? booking.booking_id : '',
        booked_from: blocksFleetNow ? booking.start_date : '',
        booked_to: blocksFleetNow ? booking.end_date : '',
        hold_expires_at: '',
        updated_at: new Date().toISOString(),
      },
    },
  );
}

async function cancelOperationalRecordsForBooking(booking, reason = 'Booking cancelled') {
  const now = new Date().toISOString();
  const subscriptions = await Subscription.find({ booking_id: booking.booking_id });

  for (const subscription of subscriptions) {
    if (
      subscription.stripe_subscription_id &&
      !['CANCELLED', 'COMPLETED'].includes(subscription.status)
    ) {
      await stripeService.cancelSubscription(subscription.stripe_subscription_id);
    }

    subscription.status = 'CANCELLED';
    subscription.billing_status = 'CANCELLED';
    subscription.cancelled_at = now;
    subscription.billing_failure_reason = reason;
    subscription.updated_at = now;
    await subscription.save();
  }

  await Hire.updateMany(
    { booking_id: booking.booking_id, status: { $ne: 'COMPLETED' } },
    {
      $set: {
        status: 'CANCELLED',
        updated_at: now,
      },
    },
  );
}

async function processBookingRefund(booking, amount, reason = 'Booking cancelled') {
  const refundAmount = Math.min(
    Number(amount) || 0,
    Number(booking.amount_upfront) || 0,
  );

  if (refundAmount <= 0) return null;

  let paymentIntentId = booking.stripe_payment_intent_id;

  if (!paymentIntentId && booking.stripe_session_id) {
    const session = await stripeService.getCheckoutSession(booking.stripe_session_id);
    paymentIntentId = session?.payment_intent;
  }

  if (!paymentIntentId) {
    throw new Error('Cannot refund because no Stripe payment intent is stored for this booking');
  }

  const refund = await stripeService.refundDeposit(
    paymentIntentId,
    Math.round(refundAmount * 100),
  );

  if (!refund?.id) {
    throw new Error('Stripe refund failed');
  }

  booking.payment_status = refundAmount >= Number(booking.amount_upfront || 0)
    ? 'REFUNDED'
    : booking.payment_status;
  booking.refund_amount = refundAmount;
  booking.refund_reason = reason;
  booking.refund_at = new Date().toISOString();
  booking.stripe_refund_id = refund.id;
  booking.stripe_payment_intent_id = paymentIntentId;

  await booking.save();
  return refund;
}

function normalizeBookingPhotoFields(booking, customer = null) {
  if (!booking) return booking;

  const customerData = customer || {};
  const frontUrl = booking.licence_photo_front_url ||
    booking.license_photo_front_url ||
    customerData.licence_photo_front_url ||
    customerData.license_photo_front_url ||
    '';
  const backUrl = booking.licence_photo_back_url ||
    booking.license_photo_back_url ||
    customerData.licence_photo_back_url ||
    customerData.license_photo_back_url ||
    '';

  return {
    ...booking,
    name: booking.name || customerData.name || customerData.full_name || '',
    phone: booking.phone || customerData.phone || '',
    email: booking.email || customerData.email || '',
    address: booking.address || customerData.address || '',
    country_of_origin: booking.country_of_origin || customerData.country_of_origin || '',
    next_of_kin: booking.next_of_kin || customerData.next_of_kin || '',
    next_of_kin_phone: booking.next_of_kin_phone || customerData.next_of_kin_phone || '',
    licence_type: booking.licence_type || customerData.licence_type || '',
    licence_photo_front_url: frontUrl,
    licence_photo_back_url: backUrl,
    license_photo_front_url: frontUrl,
    license_photo_back_url: backUrl,
  };
}

function customerLookupKeys(booking) {
  return [
    booking.customer_id ? `id:${booking.customer_id}` : '',
    booking.platform && booking.platform_id
      ? `platform:${booking.platform}:${booking.platform_id}`
      : '',
  ].filter(Boolean);
}

async function hydrateBookingCustomers(bookings) {
  const customerIds = [
    ...new Set(bookings.map((booking) => booking.customer_id).filter(Boolean)),
  ];
  const platformPairs = bookings
    .filter((booking) => booking.platform && booking.platform_id)
    .map((booking) => ({
      platform: booking.platform,
      platform_id: booking.platform_id,
    }));

  if (!customerIds.length && !platformPairs.length) return new Map();

  const customers = await Customer.find({
    $or: [
      ...customerIds.map((customer_id) => ({ customer_id })),
      ...platformPairs,
    ],
  }).lean();

  const customerMap = new Map();
  for (const customer of customers) {
    if (customer.customer_id) {
      customerMap.set(`id:${customer.customer_id}`, customer);
    }
    if (customer.platform && customer.platform_id) {
      customerMap.set(
        `platform:${customer.platform}:${customer.platform_id}`,
        customer,
      );
    }
  }

  return customerMap;
}

// GET /api/bookings - Get all bookings
router.get('/', async (req, res) => {
  try {
    const { 
      status, 
      platform, 
      scooter_type,
      start_date,
      end_date,
      search,
      page = 1, 
      limit = 50,
      sort_by = 'created_at',
      sort_order = 'desc'
    } = req.query;
    
    let filter = {};
    
    if (status && status !== 'ALL') {
      filter.status = status;
    }
    
    if (platform) {
      filter.platform = platform;
    }

    if (scooter_type) {
      filter.scooter_type = scooter_type;
    }

    if (start_date || end_date) {
      filter.created_at = {};
      if (start_date) filter.created_at.$gte = start_date;
      if (end_date) filter.created_at.$lte = end_date;
    }

    if (search) {
      filter.$or = [
        { booking_id: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const sortField = sort_by || 'created_at';
    const sortDir = sort_order === 'asc' ? 1 : -1;
    
    const bookings = await Booking.find(filter)
      .sort({ [sortField]: sortDir })
      .limit(limitNum)
      .skip(skip)
      .lean();
    
    const total = await Booking.countDocuments(filter);
    const customerMap = await hydrateBookingCustomers(bookings);
    
    res.json({
      success: true,
      data: bookings.map((booking) => {
        const customer = customerLookupKeys(booking)
          .map((key) => customerMap.get(key))
          .find(Boolean);
        return normalizeBookingPhotoFields(booking, customer);
      }),
      pagination: { 
        page: pageNum, 
        limit: limitNum, 
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('GET /api/bookings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/bookings/stats - Dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const { days = 30, start_date, end_date } = req.query;
    
    let dateFilter = {};
    if (start_date && end_date) {
      dateFilter.created_at = { $gte: start_date, $lte: end_date };
    } else {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - parseInt(days));
      dateFilter.created_at = { $gte: daysAgo.toISOString() };
    }
    
    const stats = await Booking.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          total_bookings: { $sum: 1 },
          total_revenue: { $sum: '$amount_upfront' },
          confirmed: { $sum: { $cond: [{ $eq: ['$status', 'CONFIRMED'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
          held_awaiting_payment: { $sum: { $cond: [{ $eq: ['$status', 'HELD_AWAITING_PAYMENT'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
          avg_booking_value: { $avg: '$amount_upfront' }
        }
      }
    ]);
    
    const platformStats = await Booking.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: '$platform',
          count: { $sum: 1 },
          revenue: { $sum: '$amount_upfront' }
        }
      }
    ]);

    const scooterStats = await Booking.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: '$scooter_type',
          count: { $sum: 1 },
          revenue: { $sum: '$amount_upfront' }
        }
      }
    ]);
    
    res.json({ 
      success: true, 
      data: {
        summary: stats[0] || {
          total_bookings: 0,
          total_revenue: 0,
          confirmed: 0,
          pending: 0,
          held_awaiting_payment: 0,
          cancelled: 0,
          completed: 0,
          avg_booking_value: 0
        },
        by_platform: platformStats,
        by_scooter_type: scooterStats
      }
    });
  } catch (error) {
    console.error('GET /api/bookings/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/bookings/:id - Get single booking
router.get('/:id', async (req, res) => {
  try {
    const booking = await Booking.findOne({ booking_id: req.params.id }).lean();
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    const customer = booking.customer_id
      ? await Customer.findOne({ customer_id: booking.customer_id }).lean()
      : await Customer.findOne({ platform: booking.platform, platform_id: booking.platform_id }).lean();
    
    res.json({ success: true, data: normalizeBookingPhotoFields(booking, customer) });
  } catch (error) {
    console.error(`GET /api/bookings/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/bookings - Create booking
// POST /api/bookings - Create booking
router.post('/', async (req, res) => {
  try {
    const data = pickEditableBookingFields(req.body || {});
    if (!data.booking_id) {
      data.booking_id = 'HHC-' + Date.now();
    }

    const now = new Date().toISOString();
    data.created_at = now;
    data.updated_at = now;
    data.status = data.status || 'PENDING';
    data.payment_status = data.payment_status || 'PENDING';
    applyBookingPricing(data);

    const dateError = validateBookingDates(data);
    if (dateError) {
      return res.status(400).json({ success: false, error: dateError });
    }

    const scooterError = await validateScooterAvailability(data);
    if (scooterError) {
      return res.status(409).json({ success: false, error: scooterError });
    }
    
    const booking = new Booking(data);
    await booking.save();

    await syncFleetForBooking(booking);
    if (data.status === 'CANCELLED') {
      await cancelOperationalRecordsForBooking(booking, data.notes || 'Booking cancelled via dashboard');
    }

    // 📧 Send pending booking email
    if (booking.email) {
      try {
        await emailService.sendBookingPending(booking);
        console.log('✅ Pending email sent to:', booking.email);
      } catch (emailError) {
        console.error('⚠️ Email send failed (non-blocking):', emailError.message);
      }
    }
    
    res.status(201).json({ success: true, data: normalizeBookingPhotoFields(booking.toObject()) });
  } catch (error) {
    console.error('POST /api/bookings error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Booking ID already exists' });
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/bookings/:id - Update booking
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Booking.findOne({ booking_id: id });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    const updates = pickEditableBookingFields(req.body || {});
    updates.updated_at = new Date().toISOString();

    const merged = { ...existing.toObject(), ...updates };
    const pricingTouched = [
      'scooter_type',
      'pickup_delivery',
      'first_week_rate',
      'weekly_rate',
      'deposit',
      'delivery_fee',
    ].some((field) => Object.prototype.hasOwnProperty.call(updates, field));
    applyBookingPricing(merged, {
      recalculateUpfront:
        pricingTouched &&
        !Object.prototype.hasOwnProperty.call(updates, 'amount_upfront'),
    });
    const dateError = validateBookingDates(merged);
    if (dateError) {
      return res.status(400).json({ success: false, error: dateError });
    }

    const scooterError = await validateScooterAvailability(merged, id);
    if (scooterError) {
      return res.status(409).json({ success: false, error: scooterError });
    }

    Object.assign(updates, {
      first_week_rate: merged.first_week_rate,
      weekly_rate: merged.weekly_rate,
      deposit: merged.deposit,
      delivery_fee: merged.delivery_fee,
      amount_upfront: merged.amount_upfront,
    });

    const booking = await Booking.findOneAndUpdate(
      { booking_id: id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    await syncFleetForBooking(booking, existing.scooter_plate);
    if (booking.status === 'CANCELLED') {
      await cancelOperationalRecordsForBooking(booking, booking.notes || 'Booking cancelled via dashboard');
    }

    res.json({ success: true, data: normalizeBookingPhotoFields(booking.toObject()), message: 'Booking updated successfully' });
  } catch (error) {
    console.error(`PATCH /api/bookings/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/bookings/:id/status - Update booking status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const existing = await Booking.findOne({ booking_id: id });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    const updates = {
      status,
      updated_at: new Date().toISOString()
    };

    if (status === 'CONFIRMED') {
      updates.confirmed_at = new Date().toISOString();
    } else if (status === 'CANCELLED') {
      updates.released_at = new Date().toISOString();
    } else if (status === 'COMPLETED') {
      updates.released_at = updates.released_at || new Date().toISOString();
    }

    if (notes) {
      updates.notes = notes;
    }

    const merged = { ...existing.toObject(), ...updates };
    const dateError = validateBookingDates(merged);
    if (dateError) {
      return res.status(400).json({ success: false, error: dateError });
    }

    const scooterError = await validateScooterAvailability(merged, id);
    if (scooterError) {
      return res.status(409).json({ success: false, error: scooterError });
    }

    const booking = await Booking.findOneAndUpdate(
      { booking_id: id },
      { $set: updates },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    await syncFleetForBooking(booking);
    await cancelOperationalRecordsForBooking(booking, reason || 'Booking cancelled via dashboard');

    // 📧 Send appropriate email based on status
    if (booking.email) {
      try {
        if (status === 'CONFIRMED') {
          await emailService.sendBookingConfirmation(booking);
          console.log('✅ Confirmation email sent to:', booking.email);
        } else if (status === 'CANCELLED') {
          await emailService.sendBookingCancellation(booking, notes);
          console.log('✅ Cancellation email sent to:', booking.email);
        }
      } catch (emailError) {
        console.error('⚠️ Email send failed (non-blocking):', emailError.message);
      }
    }

    res.json({ success: true, data: normalizeBookingPhotoFields(booking.toObject()), message: `Booking status updated to ${status}` });
  } catch (error) {
    console.error(`PATCH /api/bookings/${req.params.id}/status error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// PATCH /api/bookings/:id/cancel - Cancel booking
// PATCH /api/bookings/:id/cancel - Cancel booking
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, refund_amount } = req.body;

    const updates = {
      status: 'CANCELLED',
      released_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      notes: reason || 'Cancelled via dashboard'
    };

    const booking = await Booking.findOneAndUpdate(
      { booking_id: id },
      { $set: updates },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    if (refund_amount) {
      await processBookingRefund(booking, refund_amount, reason || 'Booking cancelled');
    }

    await syncFleetForBooking(booking);
    await cancelOperationalRecordsForBooking(booking, reason || 'Booking cancelled via dashboard');

    // 📧 Send cancellation email
    if (booking.email) {
      try {
        await emailService.sendBookingCancellation(booking, reason);
        console.log('✅ Cancellation email sent to:', booking.email);
      } catch (emailError) {
        console.error('⚠️ Email send failed (non-blocking):', emailError.message);
      }
    }

    res.json({ success: true, data: normalizeBookingPhotoFields(booking.toObject()), message: 'Booking cancelled successfully' });
  } catch (error) {
    console.error(`PATCH /api/bookings/${req.params.id}/cancel error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// DELETE /api/bookings/:id - Delete booking
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { hard_delete = false } = req.query;

    if (hard_delete === 'true') {
      const booking = await Booking.findOneAndDelete({ booking_id: id });
      
      if (!booking) {
        return res.status(404).json({ success: false, error: 'Booking not found' });
      }

      await syncFleetForBooking({ ...booking.toObject(), status: 'CANCELLED' }, booking.scooter_plate);
      await cancelOperationalRecordsForBooking(booking, 'Booking permanently deleted');

      res.json({ success: true, message: 'Booking permanently deleted', data: normalizeBookingPhotoFields(booking.toObject()) });
    } else {
      const booking = await Booking.findOneAndUpdate(
        { booking_id: id },
        { 
          $set: { 
            status: 'CANCELLED',
            released_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            notes: 'Deleted via dashboard'
          } 
        },
        { new: true }
      );

      if (!booking) {
        return res.status(404).json({ success: false, error: 'Booking not found' });
      }

      await syncFleetForBooking(booking);
      await cancelOperationalRecordsForBooking(booking, 'Booking deleted via dashboard');

      res.json({ success: true, message: 'Booking cancelled (soft delete)', data: normalizeBookingPhotoFields(booking.toObject()) });
    }
  } catch (error) {
    console.error(`DELETE /api/bookings/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
