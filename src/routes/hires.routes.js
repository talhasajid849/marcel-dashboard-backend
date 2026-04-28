/**
 * Hires Routes - Active Hire Management
 * Track active hires, odometer readings
 */

const express = require('express');
const router = express.Router();
const Hire = require('../models/Hire');
const Booking = require('../models/Booking');
const authMiddleware = require('../middleware/auth.middleware');

router.use(authMiddleware);

// GET /api/hires - Get all hires
router.get('/', async (req, res) => {
  try {
    const { status = 'ACTIVE', scooter_plate, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (scooter_plate) query.scooter_plate = scooter_plate;

    const hires = await Hire.find(query)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    const total = await Hire.countDocuments(query);

    res.json({
      success: true,
      data: hires,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/hires/stats - Get hire statistics
router.get('/stats', async (req, res) => {
  try {
    const [active, needingService, thursdayChecksDue] = await Promise.all([
      Hire.countDocuments({ status: 'ACTIVE' }),
      Hire.countDocuments({ status: 'ACTIVE', service_needed: true }),
      Hire.countDocuments({
        status: 'ACTIVE',
        // Add logic for Thursday checks due
      }),
    ]);

    res.json({
      success: true,
      data: {
        active,
        needingService,
        thursdayChecksDue,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/hires - Create new hire (when booking confirmed)
router.post('/', async (req, res) => {
  try {
    const hireData = req.body;

    if (!hireData.hire_id) {
      hireData.hire_id = 'HIRE-' + Date.now();
    }

    // Calculate next service due
    if (hireData.odometer_at_hire_start) {
      hireData.next_service_due_km = hireData.odometer_at_hire_start + 2000;
      hireData.current_odometer = hireData.odometer_at_hire_start;

      // Add initial odometer reading
      hireData.odometer_readings = [
        {
          reading_km: hireData.odometer_at_hire_start,
          reported_at: new Date().toISOString(),
          reported_by: 'SYSTEM',
          reading_method: 'HIRE_START',
          notes: 'Initial odometer reading at hire start',
        },
      ];
    }

    const hire = new Hire(hireData);
    await hire.save();

    res.status(201).json({ success: true, data: hire });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/hires/:id/odometer - Add odometer reading
router.post('/:id/odometer', async (req, res) => {
  try {
    const { reading_km, method = 'MANUAL', notes = '' } = req.body;

    if (!reading_km) {
      return res.status(400).json({ success: false, error: 'reading_km is required' });
    }

    const hire = await Hire.findOne({ hire_id: req.params.id });

    if (!hire) {
      return res.status(404).json({ success: false, error: 'Hire not found' });
    }

    await hire.addOdometerReading(reading_km, method, notes);

    res.json({
      success: true,
      data: hire,
      message: 'Odometer reading added',
      serviceNeeded: hire.service_needed,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/hires/:id - Get hire by ID
router.get('/:id', async (req, res) => {
  try {
    const hire = await Hire.findOne({ hire_id: req.params.id }).lean();

    if (!hire) {
      return res.status(404).json({ success: false, error: 'Hire not found' });
    }

    res.json({ success: true, data: hire });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;