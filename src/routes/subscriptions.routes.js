/**
 * Subscription Routes - API endpoints for subscription management
 */

const express = require('express');
const router = express.Router();
const Subscription = require('../models/Subscription');
const subscriptionService = require('../services/subscriptionService');
const authMiddleware = require('../middleware/auth.middleware');

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * GET /api/subscriptions - List all subscriptions
 */
router.get('/', async (req, res) => {
  try {
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

    res.json({
      success: true,
      data: subscriptions,
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
    const [
      totalSubscriptions,
      activeSubscriptions,
      pausedSubscriptions,
      completedSubscriptions,
      totalRevenue,
      pendingRevenue,
    ] = await Promise.all([
      Subscription.countDocuments(),
      Subscription.countDocuments({ status: 'ACTIVE' }),
      Subscription.countDocuments({ status: 'PAUSED' }),
      Subscription.countDocuments({ status: 'COMPLETED' }),
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
    const subscription = await Subscription.findOne({
      subscription_id: req.params.id,
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    res.json({ success: true, data: subscription });
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

    res.json({
      success: true,
      data: result,
      message: 'Payment link sent successfully',
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

    subscription.status = 'ACTIVE';
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
