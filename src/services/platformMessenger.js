'use strict';

/**
 * Platform Messenger
 * Routes outbound replies to WhatsApp, Messenger, or Instagram
 */

async function sendMessage(platform, to, text, messageData = {}) {
  const normalized = String(platform || 'whatsapp').toLowerCase();

  if (normalized === 'whatsapp') {
    const whatsappService = require('./whatsappService');
    return whatsappService.sendMessage(to, text, {
      ...messageData,
      platform: 'whatsapp',
    });
  }

  if (normalized === 'messenger' || normalized === 'instagram') {
    const metaService = require('./metaService');
    const ok = await metaService.sendMessage(to, text);

    if (ok) {
      // Save outgoing message to DB
      const Message = require('../models/Message');
      await new Message({
        message_id:   `out-${platform}-${to}-${Date.now()}`,
        platform:     normalized,
        platform_id:  to,
        direction:    'OUTGOING',
        message_type: 'text',
        message_body: text,
        status:       'SENT',
        sent_at:      new Date().toISOString(),
        created_at:   new Date().toISOString(),
        ...messageData,
      }).save().catch(e => console.warn('Outgoing save warning:', e.message));
    }

    return { success: ok };
  }

  throw new Error(`Unknown platform: ${platform}`);
}

module.exports = { sendMessage };