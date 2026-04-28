const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const Booking = require('../models/Booking');

// GET /api/customers - Get all customers
router.get('/', async (req, res) => {
  try {
    const { platform, customer_tier, customer_status, search, page = 1, limit = 50 } = req.query;
    
    let filter = {};
    
    if (platform) {
      filter.platform = platform;
    }
    
    if (customer_tier) {
      filter.customer_tier = customer_tier;
    }

    if (customer_status) {
      filter.customer_status = customer_status;
    }

    if (search) {
      filter.$or = [
        { customer_id: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { full_name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    
    const customers = await Customer.find(filter)
      .sort({ created_at: -1 })
      .limit(limitNum)
      .skip(skip)
      .lean();
    
    const total = await Customer.countDocuments(filter);
    
    res.json({
      success: true,
      data: customers,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
    });
  } catch (error) {
    console.error('GET /api/customers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/customers/stats - Get customer statistics
router.get('/stats', async (req, res) => {
  try {
    const total = await Customer.countDocuments();
    
    const by_tier = await Customer.aggregate([
      { $group: { _id: '$customer_tier', count: { $sum: 1 } } }
    ]);

    const by_platform = await Customer.aggregate([
      { $group: { _id: '$platform', count: { $sum: 1 } } }
    ]);

    const lifetime_stats = await Customer.aggregate([
      {
        $group: {
          _id: null,
          total_bookings: { $sum: '$total_bookings' },
          total_revenue: { $sum: '$total_spent' },
          avg_bookings_per_customer: { $avg: '$total_bookings' },
          avg_spent_per_customer: { $avg: '$total_spent' }
        }
      }
    ]);

    const top_customers = await Customer.find()
      .sort({ total_bookings: -1 })
      .limit(10)
      .select('customer_id name phone total_bookings total_spent customer_tier')
      .lean();

    res.json({
      success: true,
      data: {
        total,
        by_tier,
        by_platform,
        lifetime: lifetime_stats[0] || {},
        top_customers
      }
    });
  } catch (error) {
    console.error('GET /api/customers/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/customers/:id - Get single customer with bookings
router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findOne({ customer_id: req.params.id }).lean();
    
    if (!customer) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    const bookings = await Booking.find({ customer_id: req.params.id })
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    
    res.json({ success: true, data: { ...customer, bookings } });
  } catch (error) {
    console.error(`GET /api/customers/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/customers - Create new customer
router.post('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    req.body.created_at = now;
    req.body.updated_at = now;
    
    const customer = new Customer(req.body);
    await customer.save();
    
    res.status(201).json({ success: true, data: customer, message: 'Customer created successfully' });
  } catch (error) {
    console.error('POST /api/customers error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Customer ID or platform ID already exists' });
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/customers/:id - Update customer
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    delete updates.customer_id;
    delete updates.platform_id;
    delete updates.created_at;

    updates.updated_at = new Date().toISOString();

    const customer = await Customer.findOneAndUpdate(
      { customer_id: id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    res.json({ success: true, data: customer, message: 'Customer updated successfully' });
  } catch (error) {
    console.error(`PATCH /api/customers/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/customers/:id - Delete customer
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { hard_delete = false } = req.query;

    if (hard_delete === 'true') {
      const customer = await Customer.findOneAndDelete({ customer_id: id });
      
      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      res.json({ success: true, message: 'Customer permanently deleted', data: customer });
    } else {
      const customer = await Customer.findOneAndUpdate(
        { customer_id: id },
        { $set: { customer_status: 'INACTIVE', updated_at: new Date().toISOString() } },
        { new: true }
      );

      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      res.json({ success: true, message: 'Customer marked as inactive', data: customer });
    }
  } catch (error) {
    console.error(`DELETE /api/customers/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;