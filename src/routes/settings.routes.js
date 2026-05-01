const express = require('express');
const router = express.Router();
const pricingService = require('../services/pricingService');

router.get('/', async (req, res) => {
  try {
    const settings = await pricingService.getSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('GET /api/settings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/', async (req, res) => {
  try {
    const settings = await pricingService.updateSettings(req.body || {});
    res.json({ success: true, data: settings, message: 'Settings saved successfully' });
  } catch (error) {
    console.error('PATCH /api/settings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
