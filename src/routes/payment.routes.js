const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Subscription = require('../models/Subscription');

function validCheckoutSessionId(sessionId) {
  return /^cs_(test|live)_[A-Za-z0-9]+/.test(String(sessionId || ''));
}

router.get('/return-status', async (req, res) => {
  try {
    const { session_id, status } = req.query;

    if (!validCheckoutSessionId(session_id)) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: 'Missing or invalid Stripe checkout session',
      });
    }

    const booking = await Booking.findOne({ stripe_session_id: session_id }).lean();
    if (booking) {
      return res.json({
        success: true,
        valid: true,
        type: 'booking',
        status: status || '',
        booking_status: booking.status,
        payment_status: booking.payment_status,
      });
    }

    const subscription = await Subscription.findOne({
      'weekly_payments.stripe_session_id': session_id,
    }).lean();

    if (subscription) {
      const payment = subscription.weekly_payments.find(
        (week) => week.stripe_session_id === session_id,
      );

      return res.json({
        success: true,
        valid: true,
        type: 'weekly_payment',
        status: status || '',
        subscription_status: subscription.status,
        payment_status: payment?.status || '',
      });
    }

    return res.status(404).json({
      success: false,
      valid: false,
      error: 'Payment session not found',
    });
  } catch (error) {
    console.error('Payment return validation error:', error.message);
    res.status(500).json({ success: false, valid: false, error: error.message });
  }
});

module.exports = router;
