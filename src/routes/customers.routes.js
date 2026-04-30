const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const Booking = require('../models/Booking');
const Subscription = require('../models/Subscription');
const Hire = require('../models/Hire');
const Message = require('../models/Message');
const Fleet = require('../models/Fleet');
const stripeService = require('../services/stripeService');

const EDITABLE_CUSTOMER_FIELDS = [
  'platform',
  'platform_id',
  'name',
  'full_name',
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
  'customer_status',
  'notes',
  'tags',
];

function pickEditableCustomerFields(source) {
  return EDITABLE_CUSTOMER_FIELDS.reduce((acc, field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      acc[field] = source[field];
    }
    return acc;
  }, {});
}

async function cancelCustomerRelatedData(customer, permanent = false) {
  const now = new Date().toISOString();
  const bookingFilter = {
    $or: [
      { customer_id: customer.customer_id },
      { platform: customer.platform, platform_id: customer.platform_id },
      { phone: customer.phone },
      { email: customer.email },
    ].filter((condition) => Object.values(condition).every(Boolean)),
  };

  const bookings = await Booking.find(bookingFilter);
  const bookingIds = bookings.map((booking) => booking.booking_id);
  const subscriptions = await Subscription.find({
    $or: [
      { customer_id: customer.customer_id },
      { booking_id: { $in: bookingIds } },
      { customer_phone: customer.phone },
      { customer_email: customer.email },
    ].filter((condition) => {
      const value = Object.values(condition)[0];
      return Array.isArray(value?.$in) ? value.$in.length : Boolean(value);
    }),
  });

  for (const subscription of subscriptions) {
    if (
      subscription.stripe_subscription_id &&
      !['CANCELLED', 'COMPLETED'].includes(subscription.status)
    ) {
      await stripeService.cancelSubscription(subscription.stripe_subscription_id);
    }
  }

  if (permanent) {
    await Promise.all([
      Fleet.updateMany(
        { booking_id: { $in: bookingIds }, status: { $nin: ['MAINTENANCE', 'RETIRED'] } },
        {
          $set: {
            status: 'AVAILABLE',
            booking_id: '',
            booked_from: '',
            booked_to: '',
            hold_expires_at: '',
            updated_at: now,
          },
        },
      ),
      Booking.deleteMany(bookingFilter),
      Subscription.deleteMany({ _id: { $in: subscriptions.map((sub) => sub._id) } }),
      Hire.deleteMany({
        $or: [
          { booking_id: { $in: bookingIds } },
          { hirer_whatsapp_id: customer.platform_id },
          { hirer_phone: customer.phone },
          { hirer_email: customer.email },
        ].filter((condition) => Object.values(condition).every(Boolean)),
      }),
      Message.deleteMany({
        $or: [
          { customer_id: customer.customer_id },
          { platform_id: customer.platform_id },
          { customer_phone: customer.phone },
          { customer_name: customer.name },
          { booking_id: { $in: bookingIds } },
        ].filter((condition) => {
          const value = Object.values(condition)[0];
          return Array.isArray(value?.$in) ? value.$in.length : Boolean(value);
        }),
      }),
    ]);
  } else {
    await Promise.all([
      Fleet.updateMany(
        { booking_id: { $in: bookingIds }, status: { $nin: ['MAINTENANCE', 'RETIRED'] } },
        {
          $set: {
            status: 'AVAILABLE',
            booking_id: '',
            booked_from: '',
            booked_to: '',
            hold_expires_at: '',
            updated_at: now,
          },
        },
      ),
      Booking.updateMany(bookingFilter, {
        $set: {
          status: 'CANCELLED',
          released_at: now,
          updated_at: now,
          notes: 'Cancelled because customer was deleted',
        },
      }),
      Subscription.updateMany(
        { _id: { $in: subscriptions.map((sub) => sub._id) } },
        {
          $set: {
            status: 'CANCELLED',
            billing_status: 'CANCELLED',
            cancelled_at: now,
            billing_failure_reason: 'Customer deleted',
            updated_at: now,
          },
        },
      ),
      Hire.updateMany(
        {
          $or: [
            { booking_id: { $in: bookingIds } },
            { hirer_whatsapp_id: customer.platform_id },
            { hirer_phone: customer.phone },
            { hirer_email: customer.email },
          ].filter((condition) => Object.values(condition).every(Boolean)),
        },
        { $set: { status: 'CANCELLED', updated_at: now } },
      ),
    ]);
  }

  return {
    bookings: bookingIds.length,
    subscriptions: subscriptions.length,
  };
}

function deriveCustomerTier(customer) {
  const successful = Number(customer?.successful_bookings || 0);
  if (successful >= 10) return 'VIP';
  if (successful >= 3) return 'REGULAR';
  if (successful >= 2) return 'RETURNING';
  return 'NEW';
}

function tierQuery(customer_tier) {
  if (customer_tier === 'VIP') return { successful_bookings: { $gte: 10 } };
  if (customer_tier === 'REGULAR') {
    return { successful_bookings: { $gte: 3, $lt: 10 } };
  }
  if (customer_tier === 'RETURNING') return { successful_bookings: 2 };
  if (customer_tier === 'NEW') {
    return {
      $or: [
        { successful_bookings: { $exists: false } },
        { successful_bookings: { $lt: 2 } },
      ],
    };
  }
  return {};
}

function normalizeCustomer(customer) {
  if (!customer) return customer;
  return {
    ...customer,
    customer_tier: deriveCustomerTier(customer),
  };
}

// GET /api/customers - Get all customers
router.get('/', async (req, res) => {
  try {
    const { platform, customer_tier, customer_status, search, page = 1, limit = 50 } = req.query;
    
    let filter = {};
    
    if (platform) {
      filter.platform = platform;
    }
    
    if (customer_tier) {
      filter = { $and: [filter, tierQuery(customer_tier)] };
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
      data: customers.map(normalizeCustomer),
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
      {
        $addFields: {
          derived_tier: {
            $switch: {
              branches: [
                { case: { $gte: ['$successful_bookings', 10] }, then: 'VIP' },
                { case: { $gte: ['$successful_bookings', 3] }, then: 'REGULAR' },
                { case: { $gte: ['$successful_bookings', 2] }, then: 'RETURNING' },
              ],
              default: 'NEW',
            },
          },
        },
      },
      { $group: { _id: '$derived_tier', count: { $sum: 1 } } }
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
        top_customers: top_customers.map(normalizeCustomer)
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
    
    res.json({ success: true, data: { ...normalizeCustomer(customer), bookings } });
  } catch (error) {
    console.error(`GET /api/customers/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/customers - Create new customer
router.post('/', async (req, res) => {
  try {
    const data = pickEditableCustomerFields(req.body || {});
    const now = new Date().toISOString();
    data.customer_id = req.body.customer_id || `CUS-${Date.now()}`;
    data.platform_id =
      data.platform_id ||
      (data.phone ? `${data.phone.replace(/\D/g, '')}@manual` : `manual-${Date.now()}`);
    data.platform = data.platform || '';
    data.customer_status = data.customer_status || 'ACTIVE';
    data.created_at = now;
    data.updated_at = now;
    
    const customer = new Customer(data);
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
    const updates = pickEditableCustomerFields(req.body || {});
    delete updates.platform_id;

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
      const related = await cancelCustomerRelatedData(customer, true);

      res.json({ success: true, message: 'Customer and related data permanently deleted', data: customer, related });
    } else {
      const existing = await Customer.findOne({ customer_id: id });
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }
      const related = await cancelCustomerRelatedData(existing, false);
      const customer = await Customer.findOneAndUpdate(
        { customer_id: id },
        { $set: { customer_status: 'INACTIVE', updated_at: new Date().toISOString() } },
        { new: true }
      );

      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      res.json({ success: true, message: 'Customer marked inactive and related records cancelled', data: customer, related });
    }
  } catch (error) {
    console.error(`DELETE /api/customers/${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
