/**
 * Subscription Routes - API endpoints for subscription management
 */

const express = require('express');
const router = express.Router();
const Subscription = require('../models/Subscription');
const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const subscriptionService = require('../services/subscriptionService');
const stripeService = require('../services/stripeService');
const authMiddleware = require('../middleware/auth.middleware');

// Apply auth middleware to all routes
router.use(authMiddleware);

function applyCustomerFallback(subscription, booking = null, customer = null) {
  if (!subscription) return subscription;

  const data = subscription.toObject ? subscription.toObject() : subscription;
  return {
    ...data,
    customer_name:
      data.customer_name ||
      booking?.name ||
      customer?.name ||
      customer?.full_name ||
      '',
    customer_phone: data.customer_phone || booking?.phone || customer?.phone || '',
    customer_email: data.customer_email || booking?.email || customer?.email || '',
    customer_whatsapp_id:
      data.customer_whatsapp_id ||
      booking?.platform_id ||
      customer?.platform_id ||
      '',
  };
}

async function hydrateSubscriptions(subscriptions) {
  const plainSubscriptions = subscriptions.map((sub) =>
    sub.toObject ? sub.toObject() : sub,
  );
  const bookingIds = [
    ...new Set(plainSubscriptions.map((sub) => sub.booking_id).filter(Boolean)),
  ];
  const customerIds = [
    ...new Set(plainSubscriptions.map((sub) => sub.customer_id).filter(Boolean)),
  ];

  const [bookings, customers] = await Promise.all([
    bookingIds.length
      ? Booking.find({ booking_id: { $in: bookingIds } }).lean()
      : [],
    customerIds.length
      ? Customer.find({ customer_id: { $in: customerIds } }).lean()
      : [],
  ]);

  const bookingMap = new Map(bookings.map((booking) => [booking.booking_id, booking]));
  const customerMap = new Map(customers.map((customer) => [customer.customer_id, customer]));
  const cancelledBookingIds = bookings
    .filter((booking) => booking.status === 'CANCELLED')
    .map((booking) => booking.booking_id);

  if (cancelledBookingIds.length) {
    await Subscription.updateMany(
      { booking_id: { $in: cancelledBookingIds }, status: { $nin: ['CANCELLED', 'COMPLETED'] } },
      {
        $set: {
          status: 'CANCELLED',
          billing_status: 'CANCELLED',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    );
  }

  return plainSubscriptions.map((sub) =>
    applyCustomerFallback(
      bookingMap.get(sub.booking_id)?.status === 'CANCELLED'
        ? { ...sub, status: 'CANCELLED', billing_status: 'CANCELLED' }
        : sub,
      bookingMap.get(sub.booking_id),
      customerMap.get(sub.customer_id),
    ),
  );
}

async function reconcileCancelledBookingSubscriptions() {
  const cancelledBookings = await Booking.find({ status: 'CANCELLED' })
    .select('booking_id')
    .lean();
  const bookingIds = cancelledBookings.map((booking) => booking.booking_id);
  if (!bookingIds.length) return;

  await Subscription.updateMany(
    { booking_id: { $in: bookingIds }, status: { $nin: ['CANCELLED', 'COMPLETED'] } },
    {
      $set: {
        status: 'CANCELLED',
        billing_status: 'CANCELLED',
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
  );
}

async function reconcileFailedBillingSubscriptions() {
  await Subscription.updateMany(
    {
      status: 'ACTIVE',
      billing_status: { $in: ['SETUP_FAILED', 'PAYMENT_FAILED'] },
    },
    {
      $set: {
        status: 'PAUSED',
        updated_at: new Date().toISOString(),
      },
    },
  );
}

async function reconcileSubscriptionStatuses() {
  await reconcileCancelledBookingSubscriptions();
  await reconcileFailedBillingSubscriptions();
}

/**
 * GET /api/subscriptions - List all subscriptions
 */
router.get('/', async (req, res) => {
  try {
    await reconcileSubscriptionStatuses();

    const {
      status,
      customer_id,
      scooter_plate,
      page = 1,
      limit = 20,
      sort = '-created_at',
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (customer_id) filter.customer_id = customer_id;
    if (scooter_plate) filter.scooter_plate = new RegExp(scooter_plate, 'i');

    const skip = (page - 1) * limit;

    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      Subscription.countDocuments(filter),
    ]);

    const hydratedSubscriptions = await hydrateSubscriptions(subscriptions);

    res.json({
      success: true,
      data: hydratedSubscriptions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('❌ List subscriptions error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/subscriptions/stats - Get subscription statistics
 */
router.get('/stats', async (req, res) => {
  try {
    await reconcileSubscriptionStatuses();

    const [
      totalSubscriptions,
      activeSubscriptions,
      pausedSubscriptions,
      completedSubscriptions,
      failedBillingSubscriptions,
      totalRevenue,
      pendingRevenue,
    ] = await Promise.all([
      Subscription.countDocuments(),
      Subscription.countDocuments({ status: 'ACTIVE' }),
      Subscription.countDocuments({ status: 'PAUSED' }),
      Subscription.countDocuments({ status: 'COMPLETED' }),
      Subscription.countDocuments({
        billing_status: { $in: ['SETUP_FAILED', 'PAYMENT_FAILED'] },
      }),
      Subscription.aggregate([
        { $group: { _id: null, total: { $sum: '$total_paid' } } },
      ]),
      Subscription.aggregate([
        { $match: { status: { $in: ['ACTIVE', 'PAUSED'] } } },
        { $group: { _id: null, total: { $sum: '$balance_due' } } },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        total: totalSubscriptions,
        active: activeSubscriptions,
        paused: pausedSubscriptions,
        completed: completedSubscriptions,
        billing_failed: failedBillingSubscriptions,
        revenue: {
          collected: totalRevenue[0]?.total || 0,
          pending: pendingRevenue[0]?.total || 0,
        },
      },
    });
  } catch (error) {
    console.error('❌ Subscription stats error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/subscriptions/:id - Get subscription details
 */
router.get('/:id', async (req, res) => {
  try {
    await reconcileSubscriptionStatuses();

    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    const [booking, customer] = await Promise.all([
      Booking.findOne({ booking_id: subscription.booking_id }).lean(),
      subscription.customer_id
        ? Customer.findOne({ customer_id: subscription.customer_id }).lean()
        : null,
    ]);

    res.json({
      success: true,
      data: applyCustomerFallback(subscription, booking, customer),
    });
  } catch (error) {
    console.error('❌ Get subscription error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/subscriptions/:id/request-payment - Request weekly payment
 */
router.post('/:id/request-payment', async (req, res) => {
  try {
    const { week_number } = req.body;

    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    const result = await subscriptionService.requestWeeklyPayment(subscription, week_number);

    if (!result) {
      return res.status(400).json({ success: false, error: 'Failed to create payment link' });
    }

    if (subscription.customer_whatsapp_id) {
      const platformMessenger = require('../services/platformMessenger');
      await platformMessenger.sendMessage(
        'whatsapp',
        subscription.customer_whatsapp_id,
        `Hey ${subscription.customer_name}, your week ${week_number} payment of AUD ${result.amount} is ready here: ${result.paymentLink}`,
        {
          subscription_id: subscription.subscription_id,
          week_number,
        }
      );
    }

    res.json({
      success: true,
      data: result,
      message: subscription.customer_whatsapp_id
        ? 'Payment link sent successfully'
        : 'Payment link created successfully',
    });
  } catch (error) {
    console.error('❌ Request payment error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/subscriptions/:id/mark-paid - Manually mark week as paid
 */
router.post('/:id/mark-paid', async (req, res) => {
  try {
    const { week_number, payment_method = 'MANUAL' } = req.body;

    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    await subscription.markWeekPaid(week_number, null, payment_method);

    res.json({
      success: true,
      data: subscription,
      message: 'Week marked as paid',
    });
  } catch (error) {
    console.error('❌ Mark paid error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/subscriptions/:id/pause - Pause subscription
 */
router.post('/:id/pause', async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    if (subscription.stripe_subscription_id) {
      const stripeResult = await stripeService.pauseSubscription(subscription.stripe_subscription_id);
      if (!stripeResult) {
        return res.status(502).json({
          success: false,
          error: 'Failed to pause Stripe subscription',
        });
      }
    }

    subscription.status = 'PAUSED';
    subscription.updated_at = new Date().toISOString();
    await subscription.save();

    res.json({
      success: true,
      data: subscription,
      message: 'Subscription paused',
    });
  } catch (error) {
    console.error('❌ Pause subscription error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/subscriptions/:id/resume - Resume subscription
 */
router.post('/:id/resume', async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    if (!subscription.stripe_subscription_id) {
      return res.status(400).json({
        success: false,
        error: 'Cannot resume automatic billing because no Stripe subscription exists',
      });
    }

    const stripeResult = await stripeService.resumeSubscription(subscription.stripe_subscription_id);
    if (!stripeResult) {
      return res.status(502).json({
        success: false,
        error: 'Failed to resume Stripe subscription',
      });
    }

    subscription.status = 'ACTIVE';
    subscription.billing_status = 'ACTIVE';
    subscription.billing_failure_reason = '';
    subscription.updated_at = new Date().toISOString();
    await subscription.save();

    res.json({
      success: true,
      data: subscription,
      message: 'Subscription resumed',
    });
  } catch (error) {
    console.error('❌ Resume subscription error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/subscriptions/:id/complete - Complete subscription
 */
router.post('/:id/complete', async (req, res) => {
  try {
    const result = await subscriptionService.completeSubscription(req.params.id);

    if (!result) {
      return res.status(400).json({ success: false, error: 'Failed to complete subscription' });
    }

    res.json({
      success: true,
      message: 'Subscription completed',
    });
  } catch (error) {
    console.error('❌ Complete subscription error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/subscriptions/:id/refund-deposit - Process deposit refund
 */
router.post('/:id/refund-deposit', async (req, res) => {
  try {
    const { amount, reason } = req.body;

    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    // Calculate suggested refund
    const suggestedRefund = subscriptionService.calculateDepositRefund(subscription);

    const result = await subscriptionService.refundDeposit(
      req.params.id,
      amount || suggestedRefund,
      reason || 'Hire completed successfully'
    );

    if (!result) {
      return res.status(400).json({ success: false, error: 'Failed to process refund' });
    }

    res.json({
      success: true,
      message: 'Deposit refund processed',
      refund_amount: amount || suggestedRefund,
    });
  } catch (error) {
    console.error('❌ Refund deposit error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/subscriptions/:id/calculate-refund - Calculate deposit refund
 */
router.get('/:id/calculate-refund', async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    const refundAmount = subscriptionService.calculateDepositRefund(subscription);

    res.json({
      success: true,
      data: {
        deposit_amount: subscription.deposit_amount,
        weeks_paid: subscription.weeks_paid,
        total_weeks: subscription.total_weeks,
        refund_amount: refundAmount,
      },
    });
  } catch (error) {
    console.error('❌ Calculate refund error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
