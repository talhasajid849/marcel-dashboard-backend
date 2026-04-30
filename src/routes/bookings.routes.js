const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const emailService = require('../services/emailService');

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
    if (!req.body.booking_id) {
      req.body.booking_id = 'HHC-' + Date.now();
    }

    const now = new Date().toISOString();
    req.body.created_at = now;
    req.body.updated_at = now;
    
    const booking = new Booking(req.body);
    await booking.save();

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
    const updates = req.body;

    delete updates.booking_id;
    delete updates.created_at;

    updates.updated_at = new Date().toISOString();

    const booking = await Booking.findOneAndUpdate(
      { booking_id: id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
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

    const booking = await Booking.findOneAndUpdate(
      { booking_id: id },
      { $set: updates },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

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

    if (refund_amount) {
      updates.payment_status = 'REFUNDED';
    }

    const booking = await Booking.findOneAndUpdate(
      { booking_id: id },
      { $set: updates },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

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

      res.json({ success: true, message: 'Booking cancelled (soft delete)', data: normalizeBookingPhotoFields(booking.toObject()) });
    }
  } catch (error) {
    console.error(`DELETE /api/bookings/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
