'use strict';

/**
 * Meta Service — Send messages via Messenger and Instagram
 * Uses Meta Graph API to send replies
 */

const https = require('https');

const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';

/**
 * Send a text message via Meta Graph API
 * Works for both Messenger and Instagram
 */
async function sendMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('❌ META_PAGE_ACCESS_TOKEN not configured');
    return false;
  }

  const body = JSON.stringify({
    recipient: { id: recipientId },
    message:   { text },
    messaging_type: 'RESPONSE',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path:     `/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('❌ Meta send error:', parsed.error.message);
            resolve(false);
          } else {
            console.log('✅ Meta message sent to:', recipientId);
            resolve(true);
          }
        } catch (e) {
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ Meta request error:', err.message);
      resolve(false);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      console.error('❌ Meta request timeout');
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

module.exports = { sendMessage };