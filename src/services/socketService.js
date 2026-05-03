'use strict';

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Customer = require('../models/Customer');

let io = null;

function normalizeOrigin(origin) {
  return origin ? origin.replace(/\/$/, '') : origin;
}

function init(server, corsOptions = {}) {
  io = new Server(server, {
    cors: {
      origin: corsOptions.origin,
      credentials: true,
      methods: ['GET', 'POST'],
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No authentication token provided'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this');
      const user = await User.findById(decoded.userId);

      if (!user || !user.isActive) {
        return next(new Error('User not found or inactive'));
      }

      socket.user = { id: user._id.toString(), username: user.username };
      next();
    } catch (error) {
      next(new Error('Invalid socket token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join('whatsapp');

    socket.on('whatsapp:join-chat', (platformId) => {
      if (platformId) socket.join(`whatsapp-chat:${platformId}`);
    });

    socket.on('whatsapp:leave-chat', (platformId) => {
      if (platformId) socket.leave(`whatsapp-chat:${platformId}`);
    });
  });

  console.log('✅ Realtime websocket server ready');
  return io;
}

function getIO() {
  return io;
}

async function buildChatPayload(message) {
  const plain = message.toObject ? message.toObject() : message;
  const customer = await Customer.findOne({ platform_id: plain.platform_id }).lean();

  return {
    id: plain.platform_id,
    name: customer?.name || plain.platform_id,
    customerName: customer?.name || plain.platform_id,
    customerId: customer?.customer_id,
    customerTier: customer?.customer_tier,
    totalBookings: customer?.total_bookings || 0,
    lastMessage: plain.message_body,
    timestamp: new Date(plain.sent_at || plain.created_at || Date.now()).getTime(),
    unreadCount: plain.direction === 'INCOMING' ? 1 : 0,
  };
}

async function emitWhatsAppMessage(message) {
  if (!io || !message) return;

  const plain = message.toObject ? message.toObject() : message;
  const payload = {
    message: plain,
    chat: await buildChatPayload(plain),
  };

  io.to('whatsapp').emit('whatsapp:message', payload);
  io.to(`whatsapp-chat:${plain.platform_id}`).emit('whatsapp:chat-message', payload);
}

function emitWhatsAppStatus(status) {
  if (!io) return;
  io.to('whatsapp').emit('whatsapp:status', status);
}

module.exports = {
  init,
  getIO,
  emitWhatsAppMessage,
  emitWhatsAppStatus,
  normalizeOrigin,
};
