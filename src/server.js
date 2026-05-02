require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/database');
const authRoutes = require('./routes/auth.routes');
const bookingsRoutes = require('./routes/bookings.routes');
const fleetRoutes = require('./routes/fleet.routes');
const customersRoutes = require('./routes/customers.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const authMiddleware = require('./middleware/auth.middleware');
const cronService = require('./services/cronService');
const whatsappService = require('./services/whatsappService');
const servicesRoutes = require('./routes/services.routes');
const hiresRoutes = require('./routes/hires.routes');
const subscriptionsRoutes = require('./routes/subscriptions.routes');
const webhookRoutes = require('./routes/webhook.routes');
const metaRoutes = require('./routes/meta.routes');
const paymentRoutes = require('./routes/payment.routes');
const settingsRoutes = require('./routes/settings.routes');
const pricingService = require('./services/pricingService');

const app = express();

// CORS Configuration
const configuredCorsOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ORIGINS || '').split(','),
  'http://localhost:5173',
  'http://localhost:5174',
  'https://dashboard.honkhire.com',
]
  .map((origin) => origin && origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const allowedCorsOrigins = new Set(configuredCorsOrigins);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedCorsOrigins.has(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Stripe webhook needs raw body — register BEFORE express.json()
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body.toString();
    try { req.body = JSON.parse(req.rawBody); } catch (e) { req.body = {}; }
  }
  next();
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint (public - no auth required)
app.get('/health', (req, res) => {
  const mongoStatus = mongoose.connection.readyState;
  const mongoStates = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };

  res.json({
    success: true,
    message: 'Marcel Dashboard API is running',
    timestamp: new Date().toISOString(),
    mongodb: {
      status: mongoStates[mongoStatus] || 'unknown',
      connected: mongoStatus === 1
    },
    version: '2.0.0'
  });
});

function redirectToFrontend(path) {
  return (req, res) => {
    const frontendUrl = (process.env.FRONTEND_URL || process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '');
    const query = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    res.redirect(302, `${frontendUrl}${path}${query}`);
  };
}

app.get('/payment-success', redirectToFrontend('/payment-success'));
app.get('/payment-cancel', redirectToFrontend('/payment-cancel'));

// Auth routes (public - no auth required)
app.use('/api/auth', authRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/payment', paymentRoutes);

// Protected API Routes (require authentication)
app.use('/api/bookings', authMiddleware, bookingsRoutes);
app.use('/api/fleet', authMiddleware, fleetRoutes);
app.use('/api/customers', authMiddleware, customersRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/hires', hiresRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('=== ERROR ===');
  console.error('Time:', new Date().toISOString());
  console.error('Path:', req.path);
  console.error('Method:', req.method);
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);
  console.error('=============');

  res.status(err.status || 500).json({ 
    success: false, 
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Start server
async function startServer() {
  try {
    await connectDB();
    console.log('✅ MongoDB connected successfully');
    await pricingService.getSettings();
    console.log('✅ Pricing settings loaded');

    // ⏰ Start Cron Jobs
    cronService.start();

    // 📱 Initialize WhatsApp
    console.log('🔄 Starting WhatsApp service...');
    whatsappService.initialize().catch((err) => {
      console.error('⚠️  WhatsApp initialization failed:', err.message);
      console.log('💡 WhatsApp will retry connection automatically');
    });

    const PORT = process.env.PORT || 5000;
    const server = app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════╗
║   🛵 Marcel Dashboard Backend Started    ║
╠════════════════════════════════════════════╣
║   Port: ${PORT}                              ║
║   MongoDB: ✅ Connected                    ║
║   Cron Jobs: ✅ Running                    ║
║   WhatsApp: 🔄 Initializing                ║
║   Email: ✅ Configured                     ║
╚════════════════════════════════════════════╝
      `);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('⚠️  SIGTERM received. Shutting down gracefully...');

      // Stop cron jobs first
      cronService.stop();

      server.close(() => {
        console.log('✅ Server closed');
        mongoose.connection.close(false, () => {
          console.log('✅ MongoDB connection closed');
          process.exit(0);
        });
      });
    });
  } catch (error) {
    console.error('❌ Server startup failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

startServer();

module.exports = app;
