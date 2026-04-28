require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function createAdmin() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Check if admin already exists
    const existingAdmin = await User.findOne({ username: 'admin' });

    if (existingAdmin) {
      console.log('⚠️  Admin user already exists');
      console.log('Username:', existingAdmin.username);
      console.log('Email:', existingAdmin.email);
      process.exit(0);
    }

    // Create admin user
    const admin = new User({
      username: 'admin',
      email: 'admin@honkhire.com',
      password: 'admin123', // CHANGE THIS AFTER FIRST LOGIN!
      role: 'admin',
      isActive: true
    });

    await admin.save();

    console.log('');
    console.log('================================================');
    console.log('✅ Admin user created successfully!');
    console.log('================================================');
    console.log('Username: admin');
    console.log('Password: admin123');
    console.log('Email: admin@honkhire.com');
    console.log('');
    console.log('⚠️  IMPORTANT: Change this password after first login!');
    console.log('Use the /api/auth/change-password endpoint');
    console.log('================================================');
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    process.exit(1);
  }
}

createAdmin();