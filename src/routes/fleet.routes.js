const express = require('express');
const router = express.Router();
const Fleet = require('../models/Fleet');

// GET /api/fleet - Get all scooters
router.get('/', async (req, res) => {
  try {
    const { status, scooter_type, available_only = false } = req.query;
    
    let filter = {};
    
    if (status) {
      filter.status = status;
    }
    
    if (scooter_type) {
      filter.scooter_type = scooter_type;
    }

    if (available_only === 'true') {
      filter.status = 'AVAILABLE';
    }
    
    const scooters = await Fleet.find(filter)
      .sort({ scooter_plate: 1 })
      .lean();
    
    res.json({
      success: true,
      data: scooters,
      count: scooters.length
    });
  } catch (error) {
    console.error('GET /api/fleet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/fleet/stats - Get fleet statistics
router.get('/stats', async (req, res) => {
  try {
    const total = await Fleet.countDocuments();
    const available = await Fleet.countDocuments({ status: 'AVAILABLE' });
    const booked = await Fleet.countDocuments({ status: 'BOOKED' });
    const held = await Fleet.countDocuments({ status: 'HELD' });
    const maintenance = await Fleet.countDocuments({ status: 'MAINTENANCE' });

    const by_type = await Fleet.aggregate([
      {
        $group: {
          _id: '$scooter_type',
          count: { $sum: 1 },
          available: { $sum: { $cond: [{ $eq: ['$status', 'AVAILABLE'] }, 1, 0] } },
          booked: { $sum: { $cond: [{ $eq: ['$status', 'BOOKED'] }, 1, 0] } }
        }
      }
    ]);

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
    
    res.json({ success: true, data: scooter });
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