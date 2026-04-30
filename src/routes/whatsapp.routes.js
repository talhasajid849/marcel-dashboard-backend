/**
 * WhatsApp Routes - API for Frontend
 * QR code, connection status, chats, messages
 */

const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const Message = require('../models/Message');
const Customer = require('../models/Customer');
const authMiddleware = require('../middleware/auth.middleware');

// All routes require authentication
router.use(authMiddleware);

// GET /api/whatsapp/status - Get WhatsApp connection status
router.get('/status', async (req, res) => {
  try {
    const status = whatsappService.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/whatsapp/qr - Get QR code for scanning
router.get('/qr', async (req, res) => {
  try {
    const qrData = whatsappService.getQRCode();

    if (!qrData.qrCodeDataUrl && qrData.status === 'CONNECTED') {
      return res.json({
        success: true,
        data: {
          message: 'WhatsApp already connected',
          status: 'CONNECTED',
          qrCode: null,
        },
      });
    }

    if (!qrData.qrCodeDataUrl && ['DISCONNECTED', 'INITIALIZING', 'RECONNECTING'].includes(qrData.status)) {
      return res.json({
        success: true,
        data: {
          message: 'WhatsApp initializing... Please wait for QR code',
          status: qrData.status === 'DISCONNECTED' ? 'INITIALIZING' : qrData.status,
          qrCode: null,
        },
      });
    }

    if (!qrData.qrCodeDataUrl && qrData.status === 'AUTHENTICATED') {
      return res.json({
        success: true,
        data: {
          message: 'WhatsApp authenticated. Waiting for client to become ready...',
          status: 'AUTHENTICATED',
          qrCode: null,
        },
      });
    }

    res.json({
      success: true,
      data: {
        qrCode: qrData.qrCodeDataUrl,
        status: qrData.status,
        message: 'Scan this QR code with your WhatsApp',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/whatsapp/chats - Get all WhatsApp chats
router.get('/chats', async (req, res) => {
  try {
    const status = whatsappService.getStatus();

    if (!status.isReady) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp not connected',
        status: status.status,
      });
    }

    // Get chats from WhatsApp
    const whatsappChats = await whatsappService.getChats();

    // Enrich with customer data from database
    const enrichedChats = await Promise.all(
      whatsappChats.map(async (chat) => {
        // Try to find customer by platform_id
        const customer = await Customer.findOne({ platform_id: chat.id }).lean();

        return {
          ...chat,
          customerName: customer?.name || chat.name,
          customerId: customer?.customer_id,
          customerTier: customer?.customer_tier,
          totalBookings: customer?.total_bookings || 0,
        };
      })
    );

    // Sort by last message timestamp
    enrichedChats.sort((a, b) => b.timestamp - a.timestamp);

    res.json({ success: true, data: enrichedChats, total: enrichedChats.length });
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/whatsapp/messages/:platformId - Get messages for a specific chat
router.get('/messages/:platformId', async (req, res) => {
  try {
    const { platformId } = req.params;
    const { limit = 50, before } = req.query;

    const query = { platform_id: platformId };

    // Pagination support
    if (before) {
      query.created_at = { $lt: before };
    }

    const messages = await Message.find(query)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .lean();

    // Reverse to show oldest first
    const orderedMessages = messages.reverse();

    // Get customer info
    const customer = await Customer.findOne({ platform_id: platformId }).lean();

    res.json({
      success: true,
      data: {
        messages: orderedMessages,
        customer: customer
          ? {
              customer_id: customer.customer_id,
              name: customer.name,
              phone: customer.phone,
              email: customer.email,
              tier: customer.customer_tier,
              total_bookings: customer.total_bookings,
            }
          : null,
      },
      total: orderedMessages.length,
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/whatsapp/send - Send WhatsApp message
router.post('/send', async (req, res) => {
  try {
    const { to, message, booking_id, hire_id } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, message',
      });
    }

    const status = whatsappService.getStatus();
    if (!status.isReady) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp not connected',
      });
    }

    const messageData = {};
    if (booking_id) messageData.booking_id = booking_id;
    if (hire_id) messageData.hire_id = hire_id;

    const result = await whatsappService.sendMessage(to, message, messageData);

    res.json({
      success: true,
      data: result,
      message: 'Message sent successfully',
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/whatsapp/mark-read - Mark chat as read
router.post('/mark-read', async (req, res) => {
  try {
    const { chatId } = req.body;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'Missing chatId' });
    }

    const result = await whatsappService.markAsRead(chatId);

    res.json({ success: result, message: result ? 'Marked as read' : 'Failed to mark as read' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/whatsapp/typing - Set typing indicator
router.post('/typing', async (req, res) => {
  try {
    const { chatId, isTyping = true } = req.body;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'Missing chatId' });
    }

    const result = await whatsappService.setTyping(chatId, isTyping);

    res.json({ success: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/whatsapp/stats - Get WhatsApp statistics
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalMessages, todayMessages, uniqueChats, incomingMessages, outgoingMessages] =
      await Promise.all([
        Message.countDocuments(),
        Message.countDocuments({ created_at: { $gte: today.toISOString() } }),
        Message.distinct('platform_id'),
        Message.countDocuments({ direction: 'INCOMING' }),
        Message.countDocuments({ direction: 'OUTGOING' }),
      ]);

    res.json({
      success: true,
      data: {
        totalMessages,
        todayMessages,
        uniqueChats: uniqueChats.length,
        incomingMessages,
        outgoingMessages,
        responseRate:
          incomingMessages > 0
            ? Math.min(
                100,
                Math.round((outgoingMessages / incomingMessages) * 100),
              )
            : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
