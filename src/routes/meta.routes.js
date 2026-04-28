'use strict';

/**
 * Meta Webhook - Handles Facebook Messenger + Instagram DMs
 * Both platforms use the same webhook endpoint
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const Message = require('../models/Message');

const VERIFY_TOKEN    = process.env.META_VERIFY_TOKEN    || 'honkhire_webhook_2026';
const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';
const APP_SECRET      = process.env.META_APP_SECRET      || '';

// ── Verify webhook signature from Meta ──────────────────────────────────────
function verifySignature(req) {
  if (!APP_SECRET) return true; // skip in dev if not configured

  const signature = req.headers['x-hub-signature-256'] || '';
  const expected  = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// ── GET /api/meta/webhook — Meta verification handshake ─────────────────────
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }

  console.error('❌ Meta webhook verification failed');
  res.status(403).send('Forbidden');
});

// ── POST /api/meta/webhook — Incoming messages ───────────────────────────────
router.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.status(200).send('EVENT_RECEIVED');

  try {
    if (!verifySignature(req)) {
      console.error('❌ Meta webhook signature invalid');
      return;
    }

    const body = req.body;

    if (!body?.object) return;

    // Messenger
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          await handleMessengerEvent(event);
        }
      }
    }

    // Instagram
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          await handleInstagramEvent(event);
        }
      }
    }
  } catch (err) {
    console.error('❌ Meta webhook error:', err.message);
  }
});

// ── Handle Messenger message ─────────────────────────────────────────────────
async function handleMessengerEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId) return;

  // Ignore echo (messages sent by your page)
  if (event.message?.is_echo) return;

  const text     = event.message?.text || '';
  const hasMedia = !!(event.message?.attachments?.length);
  let   mediaUrl = '';

  if (hasMedia) {
    mediaUrl = event.message.attachments?.[0]?.payload?.url || '';
  }

  console.log(`📨 Messenger message from ${senderId}: "${text.substring(0, 60)}"`);

  await saveAndProcess('messenger', senderId, text, mediaUrl);
}

// ── Handle Instagram DM ──────────────────────────────────────────────────────
async function handleInstagramEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId) return;

  if (event.message?.is_echo) return;

  const text     = event.message?.text || '';
  const hasMedia = !!(event.message?.attachments?.length);
  let   mediaUrl = '';

  if (hasMedia) {
    mediaUrl = event.message.attachments?.[0]?.payload?.url || '';
  }

  console.log(`📨 Instagram DM from ${senderId}: "${text.substring(0, 60)}"`);

  await saveAndProcess('instagram', senderId, text, mediaUrl);
}

// ── Save to DB and pass to message handler ───────────────────────────────────
async function saveAndProcess(platform, platformId, text, mediaUrl = '') {
  try {
    const message = new Message({
      message_id:   `${platform}-${platformId}-${Date.now()}`,
      platform,
      platform_id:  platformId,
      direction:    'INCOMING',
      message_type: mediaUrl ? 'image' : 'text',
      message_body: text,
      media_url:    mediaUrl,
      status:       'DELIVERED',
      sent_at:      new Date().toISOString(),
      created_at:   new Date().toISOString(),
    });

    await message.save().catch(e => {
      if (e.code !== 11000) throw e; // ignore duplicates
    });

    // Pass to message handler
    const messageHandler = require('../services/messageHandler');
    setImmediate(async () => {
      try {
        await messageHandler.processIncomingMessage(message);
      } catch (err) {
        console.error(`❌ ${platform} handler error:`, err.message);
      }
    });
  } catch (err) {
    console.error(`❌ saveAndProcess error (${platform}):`, err.message);
  }
}

// ── GET /api/meta/:platform/chats ────────────────────────────────────────────
router.get('/:platform/chats', async (req, res) => {
  try {
    const { platform } = req.params;
    const chats = await Message.aggregate([
      { $match: { platform } },
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id:         '$platform_id',
          lastMessage: { $first: '$message_body' },
          lastTime:    { $first: '$created_at' },
          unreadCount: {
            $sum: { $cond: [{ $eq: ['$direction', 'INCOMING'] }, 1, 0] },
          },
        },
      },
      { $sort: { lastTime: -1 } },
      { $limit: 50 },
    ]);

    const data = chats.map(c => ({
      id:          c._id,
      name:        c._id,
      lastMessage: c.lastMessage,
      lastTime:    c.lastTime,
      unreadCount: c.unreadCount,
    }));

    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/meta/:platform/chats/:platformId/messages ───────────────────────
router.get('/:platform/chats/:platformId/messages', async (req, res) => {
  try {
    const { platform, platformId } = req.params;
    const messages = await Message.find({
      platform,
      platform_id: decodeURIComponent(platformId),
    })
      .sort({ created_at: 1 })
      .limit(100)
      .lean();

    res.json({ success: true, data: messages });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/meta/:platform/chats/:platformId/send ──────────────────────────
router.post('/:platform/chats/:platformId/send', async (req, res) => {
  try {
    const { platform, platformId } = req.params;
    const { message } = req.body;
    const decoded = decodeURIComponent(platformId);

    if (!message) return res.status(400).json({ success: false, error: 'Message required' });

    const metaService = require('../services/metaService');
    const ok = await metaService.sendMessage(decoded, message);

    if (ok) {
      await Message.create({
        message_id:   `out-${platform}-${decoded}-${Date.now()}`,
        platform,
        platform_id:  decoded,
        direction:    'OUTGOING',
        message_type: 'text',
        message_body: message,
        status:       'SENT',
        sent_at:      new Date().toISOString(),
        created_at:   new Date().toISOString(),
      });
    }

    res.json({ success: true, sent: ok });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/meta/:platform/stats ────────────────────────────────────────────
router.get('/:platform/stats', async (req, res) => {
  try {
    const { platform } = req.params;
    const [totalChats, totalMessages, incoming, outgoing] = await Promise.all([
      Message.distinct('platform_id', { platform }).then(r => r.length),
      Message.countDocuments({ platform }),
      Message.countDocuments({ platform, direction: 'INCOMING' }),
      Message.countDocuments({ platform, direction: 'OUTGOING' }),
    ]);

    res.json({ success: true, stats: { totalChats, totalMessages, incoming, outgoing } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;