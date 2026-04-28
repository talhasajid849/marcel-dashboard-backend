const mongoose = require('mongoose');

const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing in .env');
  }

  while (true) {
    try {
      const conn = await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000
      });

      console.log(`MongoDB Connected: ${conn.connection.host}`);
      console.log(`Database: ${conn.connection.name}`);
      return conn;
    } catch (error) {
      console.error('MongoDB Connection Failed:', error.message);
      console.log('Retrying MongoDB in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed');
  process.exit(0);
});

module.exports = connectDB;
