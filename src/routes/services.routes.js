/**
 * Services Routes - Service Management API
 * Odometer tracking, service scheduling
 */

const express = require('express');
const router = express.Router();
const Service = require('../models/Service');
const Hire = require('../models/Hire');
const authMiddleware = require('../middleware/auth.middleware');

// All routes require authentication
router.use(authMiddleware);

// GET /api/services - Get all services
router.get('/', async (req, res) => {
  try {
    const { status, scooter_plate, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (scooter_plate) query.scooter_plate = scooter_plate;

    const services = await Service.find(query)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    const total = await Service.countDocuments(query);

    res.json({
      success: true,
      data: services,
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

// GET /api/services/stats - Get service statistics
router.get('/stats', async (req, res) => {
  try {
    const [total, scheduled, inProgress, completed, thisMonth] = await Promise.all([
      Service.countDocuments(),
      Service.countDocuments({ status: 'SCHEDULED' }),
      Service.countDocuments({ status: 'IN_PROGRESS' }),
      Service.countDocuments({ status: 'COMPLETED' }),
      Service.countDocuments({
        created_at: {
          $gte: new Date(new Date().setDate(1)).toISOString(),
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        scheduled,
        inProgress,
        completed,
        thisMonth,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/services/:id - Get service by ID
router.get('/:id', async (req, res) => {
  try {
    const service = await Service.findOne({ service_id: req.params.id }).lean();

    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    res.json({ success: true, data: service });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/services - Create new service
router.post('/', async (req, res) => {
  try {
    const serviceData = req.body;

    if (!serviceData.service_id) {
      serviceData.service_id = 'SVC-' + Date.now();
    }

    const service = new Service(serviceData);
    await service.save();

    res.status(201).json({ success: true, data: service });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/services/:id - Update service
router.patch('/:id', async (req, res) => {
  try {
    const updates = {
      ...req.body,
      updated_at: new Date().toISOString(),
    };

    const service = await Service.findOneAndUpdate(
      { service_id: req.params.id },
      { $set: updates },
      { new: true }
    );

    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    res.json({ success: true, data: service });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/services/scooter/:plate/history - Get service history for scooter
router.get('/scooter/:plate/history', async (req, res) => {
  try {
    const services = await Service.find({ scooter_plate: req.params.plate })
      .sort({ created_at: -1 })
      .lean();

    res.json({ success: true, data: services, total: services.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;