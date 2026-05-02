'use strict';

/**
 * WhatsApp Service using Baileys
 * Pure WebSocket - no Chrome, no Puppeteer
 * Sessions survive restarts automatically
 */

const path  = require('path');
const fs    = require('fs');
const Message = require('../models/Message');

function toIsoFromBaileysTimestamp(value) {
  const raw = typeof value === 'object' && value?.toNumber
    ? value.toNumber()
    : Number(value);

  if (!Number.isFinite(raw)) {
    return new Date().toISOString();
  }

  // Baileys usually gives seconds. Be tolerant if a millisecond value arrives.
  const millis = raw > 1000000000000 ? raw : raw * 1000;
  return new Date(millis).toISOString();
}

class WhatsAppService {
  constructor() {
    this.sock          = null;
    this.isReady       = false;
    this.qrCode        = null;
    this.qrCodeDataUrl = null;
    this.connectionStatus = 'DISCONNECTED';
    this.lastError     = null;
    this.authDir       = path.resolve(process.env.WHATSAPP_SESSION_PATH || './whatsapp_session');
    this.retryCount    = 0;
    this.maxRetries    = Number(process.env.WHATSAPP_MAX_RETRIES || 10);
    this.isStarting    = false;
    this.reconnectTimer = null;
  }

  async initialize() {
    if (this.isStarting) return;
    this.isStarting = true;
    this.connectionStatus = this.isReady ? 'CONNECTED' : 'INITIALIZING';
    this.lastError = null;

    // Baileys must be imported dynamically (ESM module)
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = 
      await import('@whiskeysockets/baileys');
    const { Boom } = await import('@hapi/boom');
    const pino = (await import('pino')).default;

    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log('📱 Starting Baileys WhatsApp client, version:', version.join('.'));

    this.sock = makeWASocket({
      version,
      auth:   state,
      logger: pino({ level: 'silent' }), // suppress Baileys internal logs
      printQRInTerminal: false,           // we handle QR ourselves
      browser: ['Marcel Bot', 'Chrome', '120.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.isStarting = false;

    // Save credentials whenever they update
    this.sock.ev.on('creds.update', saveCreds);

    // Connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code generated — convert to data URL for dashboard
      if (qr) {
        console.log('📱 WhatsApp QR code ready — scan with your phone');
        this.qrCode = qr;
        this.connectionStatus = 'QR_READY';
        this.isReady = false;

        // Convert QR to data URL for dashboard display
        try {
          const QRCode = require('qrcode');
          this.qrCodeDataUrl = await QRCode.toDataURL(qr);
        } catch (e) {
          console.error('QR to DataURL failed:', e.message);
        }
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp connected!');
        this.isReady       = true;
        this.qrCode        = null;
        this.qrCodeDataUrl = null;
        this.connectionStatus = 'CONNECTED';
        this.lastError     = null;
        this.retryCount    = 0;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut  = statusCode === DisconnectReason.loggedOut;
        const qrTimeout  = statusCode === 408 && !this.isReady;

        this.isReady = false;
        this.connectionStatus = loggedOut ? 'AUTH_FAILED' : 'RECONNECTING';
        this.lastError = `Disconnected with status ${statusCode || 'unknown'}`;
        console.log(`⚠️  WhatsApp disconnected. Status: ${statusCode} | Logged out: ${loggedOut}`);

        if (loggedOut) {
          // Session expired — delete auth files and re-scan QR
          console.log('🗑️  Session expired. Deleting auth files, will show QR again...');
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.retryCount = 0;
          this.scheduleReconnect(3000, 'logged out');
        } else if (qrTimeout) {
          this.retryCount = 0;
          this.scheduleReconnect(5000, 'QR timed out');
        } else if (this.retryCount < this.maxRetries) {
          // Temporary disconnect — reconnect automatically
          this.retryCount++;
          const delay = Math.min(5000 * this.retryCount, 60000);
          console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${this.retryCount}/${this.maxRetries})...`);
          this.scheduleReconnect(delay, `attempt ${this.retryCount}/${this.maxRetries}`);
        } else {
          this.connectionStatus = 'ERROR';
          this.lastError = 'Max reconnect attempts reached. Restart WhatsApp from the dashboard or restart the backend.';
          console.error('❌ Max reconnect attempts reached. Restart the server manually.');
        }
      }
    });

    // Incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          await this.handleIncomingMessage(msg);
        } catch (error) {
          console.error('Message handling error:', error.message);
        }
      }
    });
  }

  scheduleReconnect(delay, reason) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.connectionStatus = 'RECONNECTING';
    console.log(`Reconnecting WhatsApp in ${delay / 1000}s (${reason})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initialize();
    }, delay);
  }

  async restart({ clearSession = false } = {}) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (this.sock?.end) {
        this.sock.end(undefined);
      }
    } catch (error) {
      console.warn('WhatsApp socket close warning:', error.message);
    }

    if (clearSession) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    }

    this.sock = null;
    this.isReady = false;
    this.qrCode = null;
    this.qrCodeDataUrl = null;
    this.connectionStatus = 'INITIALIZING';
    this.lastError = null;
    this.retryCount = 0;
    this.isStarting = false;

    await this.initialize();
    return this.getStatus();
  }

  async ensureStarted() {
    if (!this.sock && !this.isStarting && !this.reconnectTimer) {
      await this.initialize();
    }
  }

  async handleIncomingMessage(msg) {
    // Ignore messages from yourself, groups, broadcast, status
    if (msg.key.fromMe) return;
    if (!msg.key.remoteJid) return;
    if (msg.key.remoteJid === 'status@broadcast') return;
    if (msg.key.remoteJid.endsWith('@g.us')) return;
    if (msg.key.remoteJid.includes('@newsletter')) return;

    const from     = msg.key.remoteJid;
    const incomingMessageId = `${from}-${msg.key.id || Date.now()}`;
    const body     = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text ||
                     msg.message?.imageMessage?.caption || '';
    const hasMedia = !!(msg.message?.imageMessage || msg.message?.documentMessage);

    console.log('📨 WhatsApp message received:', {
      from,
      body: body.substring(0, 60),
    });

    // Tell WhatsApp the bot device has read the customer's message. This allows
    // double/blue ticks when the customer's own read-receipt settings allow it.
    try {
      if (this.sock?.readMessages) {
        await this.sock.readMessages([msg.key]);
      }
    } catch (err) {
      console.warn('WhatsApp read receipt warning:', err.message);
    }

    // Save to DB
    const message = new Message({
      message_id:   incomingMessageId,
      platform:     'whatsapp',
      platform_id:  from,
      direction:    'INCOMING',
      message_type: hasMedia ? 'image' : 'text',
      message_body: body,
      status:       'DELIVERED',
      sent_at:      toIsoFromBaileysTimestamp(msg.messageTimestamp),
      created_at:   new Date().toISOString(),
    });

    // Handle media (licence photos)
    if (hasMedia) {
      try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: this.sock.updateMediaMessage });
        
        // Upload to Cloudinary
        const cloudinary = require('../utils/cloudinaryConfig');
        if (cloudinary.isConfigured()) {
          const base64 = buffer.toString('base64');
          const mimetype = msg.message?.imageMessage?.mimetype || 'image/jpeg';
          const dataUri = `data:${mimetype};base64,${base64}`;
          const uploaded = await cloudinary.uploadDataUri(dataUri, {
            publicId: incomingMessageId,
          });
          message.media_url = uploaded.url;
        }
      } catch (err) {
        console.error('Media download error:', err.message);
      }
    }

    try {
      await message.save();
    } catch (err) {
      if (err?.code === 11000) {
        console.warn('Duplicate incoming WhatsApp message skipped:', incomingMessageId);
        return;
      }
      throw err;
    }

    console.log('✅ Incoming WhatsApp message saved; invoking handler:', incomingMessageId);

    // Pass to message handler
    let messageHandler = null;
    try {
      messageHandler = require('./messageHandler');
    } catch (e) {
      console.error('Message handler load error:', e.message);
    }

    if (messageHandler?.processIncomingMessage) {
      console.log('➡️ Passing WhatsApp message to handler:', incomingMessageId);
      setImmediate(async () => {
        try {
          await messageHandler.processIncomingMessage(message);
        } catch (err) {
          console.error('Message handler error:', err.message);
        }
      });
    }
  }

  async sendMessage(to, text, messageData = {}) {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp not connected');
    }

    // Normalize to JID format
    const jid = to.includes('@') ? to : `${to.replace(/^\+/, '')}@c.us`;

    await this.sock.sendMessage(jid, { text });

    // Save outgoing message to DB
    const message = new Message({
      message_id:   `out-${Date.now()}`,
      platform:     messageData.platform || 'whatsapp',
      platform_id:  jid,
      direction:    'OUTGOING',
      message_type: 'text',
      message_body: text,
      status:       'SENT',
      sent_at:      new Date().toISOString(),
      created_at:   new Date().toISOString(),
      ...messageData,
    });

    await message.save().catch(e => console.warn('Outgoing save warning:', e.message));

    console.log('📤 WhatsApp message sent to:', jid);
    return { success: true, timestamp: new Date().toISOString() };
  }

  getQRCode() {
    return {
      qrCode:        this.qrCode,
      qrCodeDataUrl: this.qrCodeDataUrl,
      status:        this.connectionStatus,
      isReady:       this.isReady,
      lastError:     this.lastError,
    };
  }

  getStatus() {
    return {
      isReady:       this.isReady,
      status:        this.connectionStatus,
      hasQR:         !!this.qrCodeDataUrl,
      lastError:     this.lastError,
      authDir:       this.authDir,
      retryCount:    this.retryCount,
      isStarting:    this.isStarting,
    };
  }

  async getChats() {
    const chats = await Message.aggregate([
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id:         '$platform_id',
          lastMessage: { $first: '$message_body' },
          lastTime:    { $first: '$created_at' },
          unread: {
            $sum: {
              $cond: [{ $eq: ['$direction', 'INCOMING'] }, 1, 0],
            },
          },
        },
      },
      { $sort: { lastTime: -1 } },
      { $limit: 50 },
    ]);

    return chats.map(c => ({
      id:          c._id,
      name:        c._id,
      lastMessage: c.lastMessage,
      timestamp:   c.lastTime,
      unreadCount: c.unread,
    }));
  }

  async getChatMessages(platformId, limit = 50) {
    return Message.find({ platform_id: platformId })
      .sort({ created_at: 1 })
      .limit(limit)
      .lean();
  }
}

module.exports = new WhatsAppService();
