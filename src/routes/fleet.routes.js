const express = require('express');
const router = express.Router();
const Fleet = require('../models/Fleet');
const Booking = require('../models/Booking');

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function addDays(date, days) {
  const value = startOfDay(date);
  value.setDate(value.getDate() + days);
  return value;
}

function dateRangeContains(date, startDate, endDate) {
  const day = startOfDay(date);
  const start = startOfDay(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  if ([day, start, end].some((value) => Number.isNaN(value.getTime()))) {
    return false;
  }

  return day >= start && day <= end;
}

function holdIsActive(booking, now = new Date()) {
  if (booking.status !== 'HELD_AWAITING_PAYMENT') return false;
  if (!booking.hold_expires_at) return true;

  const expiresAt = new Date(booking.hold_expires_at);
  return Number.isNaN(expiresAt.getTime()) || expiresAt > now;
}

function deriveFleetStatus(scooter, bookings, now = new Date()) {
  if (['MAINTENANCE', 'RETIRED'].includes(scooter.status)) {
    return {
      ...scooter,
      display_status: scooter.status,
    };
  }

  const activeBooking = bookings.find(
    (booking) =>
      booking.status === 'CONFIRMED' &&
      dateRangeContains(now, booking.start_date, booking.end_date)
  );

  if (activeBooking) {
    return {
      ...scooter,
      status: 'BOOKED',
      display_status: 'BOOKED',
      booking_id: activeBooking.booking_id,
      booked_from: activeBooking.start_date,
      booked_to: activeBooking.end_date,
      next_booking: activeBooking,
    };
  }

  const tomorrow = addDays(now, 1);
  const nearHold = bookings.find(
    (booking) =>
      holdIsActive(booking, now) &&
      dateRangeContains(tomorrow, booking.start_date, booking.end_date)
  );

  if (nearHold) {
    return {
      ...scooter,
      status: 'HELD',
      display_status: 'HELD',
      booking_id: nearHold.booking_id,
      booked_from: nearHold.start_date,
      booked_to: nearHold.end_date,
      hold_expires_at: nearHold.hold_expires_at,
      next_booking: nearHold,
    };
  }

  const upcomingBooking = bookings.find(
    (booking) =>
      ['CONFIRMED', 'HELD_AWAITING_PAYMENT'].includes(booking.status) &&
      new Date(booking.start_date) > startOfDay(now)
  );

  return {
    ...scooter,
    status: 'AVAILABLE',
    display_status: 'AVAILABLE',
    booking_id: '',
    booked_from: '',
    booked_to: '',
    hold_expires_at: '',
    next_booking: upcomingBooking || null,
  };
}

async function hydrateFleetStatuses(scooters) {
  const plates = scooters.map((scooter) => scooter.scooter_plate).filter(Boolean);
  if (!plates.length) return scooters;

  const bookings = await Booking.find({
    scooter_plate: { $in: plates },
    status: { $in: ['HELD_AWAITING_PAYMENT', 'CONFIRMED'] },
    payment_status: { $ne: 'EXPIRED' },
    start_date: { $exists: true, $nin: [null, ''] },
    end_date: { $exists: true, $nin: [null, ''] },
  }).sort({ start_date: 1 }).lean();

  const bookingsByPlate = new Map();
  for (const booking of bookings) {
    if (!bookingsByPlate.has(booking.scooter_plate)) {
      bookingsByPlate.set(booking.scooter_plate, []);
    }
    bookingsByPlate.get(booking.scooter_plate).push(booking);
  }

  const now = new Date();
  return scooters.map((scooter) =>
    deriveFleetStatus(scooter, bookingsByPlate.get(scooter.scooter_plate) || [], now)
  );
}

// GET /api/fleet - Get all scooters
router.get('/', async (req, res) => {
  try {
    const { status, scooter_type, available_only = false } = req.query;
    
    let filter = {};
    
    if (scooter_type) {
      filter.scooter_type = scooter_type;
    }
    
    const scooters = await Fleet.find(filter)
      .sort({ scooter_plate: 1 })
      .lean();

    const hydratedScooters = await hydrateFleetStatuses(scooters);
    const filteredScooters = hydratedScooters.filter((scooter) => {
      if (status && scooter.status !== status) return false;
      if (available_only === 'true' && scooter.status !== 'AVAILABLE') return false;
      return true;
    });
    
    res.json({
      success: true,
      data: filteredScooters,
      count: filteredScooters.length
    });
  } catch (error) {
    console.error('GET /api/fleet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/fleet/stats - Get fleet statistics
router.get('/stats', async (req, res) => {
  try {
    const allScooters = await Fleet.find({}).lean();
    const hydratedScooters = await hydrateFleetStatuses(allScooters);
    const total = hydratedScooters.length;
    const available = hydratedScooters.filter((s) => s.status === 'AVAILABLE').length;
    const booked = hydratedScooters.filter((s) => s.status === 'BOOKED').length;
    const held = hydratedScooters.filter((s) => s.status === 'HELD').length;
    const maintenance = hydratedScooters.filter((s) => s.status === 'MAINTENANCE').length;

    const byTypeMap = new Map();
    for (const scooter of hydratedScooters) {
      if (!byTypeMap.has(scooter.scooter_type)) {
        byTypeMap.set(scooter.scooter_type, {
          _id: scooter.scooter_type,
          count: 0,
          available: 0,
          booked: 0,
        });
      }
      const row = byTypeMap.get(scooter.scooter_type);
      row.count += 1;
      if (scooter.status === 'AVAILABLE') row.available += 1;
      if (scooter.status === 'BOOKED') row.booked += 1;
    }
    const by_type = [...byTypeMap.values()];

    const utilization = await Fleet.aggregate([
      {
        $group: {
          _id: null,
          total_bookings: { $sum: '$total_bookings' },
          avg_bookings: { $avg: '$total_bookings' },
          total_days_rented: { $sum: '$total_days_rented' }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        total,
        available,
        booked,
        held,
        maintenance,
        utilization_rate: total > 0 ? ((booked + held) / total * 100).toFixed(2) : 0,
        by_type,
        utilization: utilization[0] || {}
      }
    });
  } catch (error) {
    console.error('GET /api/fleet/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/fleet/:plate - Get single scooter
router.get('/:plate', async (req, res) => {
  try {
    const scooter = await Fleet.findOne({ scooter_plate: req.params.plate }).lean();
    
    if (!scooter) {
      return res.status(404).json({ success: false, error: 'Scooter not found' });
    }
    
    const [hydratedScooter] = await hydrateFleetStatuses([scooter]);
    res.json({ success: true, data: hydratedScooter });
  } catch (error) {
    console.error(`GET /api/fleet/${req.params.plate} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/fleet - Add new scooter
router.post('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    req.body.created_at = now;
    req.body.updated_at = now;
    req.body.status = req.body.status || 'AVAILABLE';
    
    const scooter = new Fleet(req.body);
    await scooter.save();
    
    res.status(201).json({ 
      success: true, 
      data: scooter,
      message: 'Scooter added to fleet successfully'
    });
  } catch (error) {
    console.error('POST /api/fleet error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Scooter plate already exists' });
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/fleet/:plate - Update scooter
router.patch('/:plate', async (req, res) => {
  try {
    const { plate } = req.params;
    const updates = req.body;

    delete updates.scooter_plate;
    delete updates.created_at;

    updates.updated_at = new Date().toISOString();

    const scooter = await Fleet.findOneAndUpdate(
      { scooter_plate: plate },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!scooter) {
      return res.status(404).json({ success: false, error: 'Scooter not found' });
    }

    res.json({ success: true, data: scooter, message: 'Scooter updated successfully' });
  } catch (error) {
    console.error(`PATCH /api/fleet/${req.params.plate} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/fleet/:plate/status - Update scooter status
router.patch('/:plate/status', async (req, res) => {
  try {
    const { plate } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const updates = {
      status,
      updated_at: new Date().toISOString()
    };

    if (status === 'AVAILABLE') {
      updates.booked_from = '';
      updates.booked_to = '';
      updates.booking_id = '';
      updates.hold_expires_at = '';
    }

    const scooter = await Fleet.findOneAndUpdate(
      { scooter_plate: plate },
      { $set: updates },
      { new: true }
    );

    if (!scooter) {
      return res.status(404).json({ success: false, error: 'Scooter not found' });
    }

    res.json({ success: true, data: scooter, message: `Scooter status updated to ${status}` });
  } catch (error) {
    console.error(`PATCH /api/fleet/${req.params.plate}/status error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/fleet/:plate - Remove scooter
router.delete('/:plate', async (req, res) => {
  try {
    const { plate } = req.params;
    const { hard_delete = false } = req.query;

    if (hard_delete === 'true') {
      const scooter = await Fleet.findOneAndDelete({ scooter_plate: plate });
      
      if (!scooter) {
        return res.status(404).json({ success: false, error: 'Scooter not found' });
      }

      res.json({ success: true, message: 'Scooter permanently removed from fleet', data: scooter });
    } else {
      const scooter = await Fleet.findOneAndUpdate(
        { scooter_plate: plate },
        { $set: { status: 'RETIRED', updated_at: new Date().toISOString() } },
        { new: true }
      );

      if (!scooter) {
        return res.status(404).json({ success: false, error: 'Scooter not found' });
      }

      res.json({ success: true, message: 'Scooter marked as retired', data: scooter });
    }
  } catch (error) {
    console.error(`DELETE /api/fleet/${req.params.plate} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
