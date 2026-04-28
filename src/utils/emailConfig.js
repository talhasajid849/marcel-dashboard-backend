/**
 * Email Configuration
 * Centralized email settings - easily switch providers
 */

const nodemailer = require("nodemailer");

// Email provider configuration
const emailConfig = {
  // Option 1: Gmail (for testing)
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || "465"),
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },

  // Option 2: SendGrid
  sendgrid: {
    host: "smtp.sendgrid.net",
    port: 587,
    auth: {
      user: "apikey",
      pass: process.env.SENDGRID_API_KEY,
    },
  },

  // Option 3: Custom SMTP
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },
};

// Create transporter based on environment
const createTransporter = () => {
  const provider = process.env.EMAIL_PROVIDER || "gmail";
  const config = emailConfig[provider];

  if (!config) {
    console.error("Invalid email provider:", provider);
    return null;
  }

  try {
    const transporter = nodemailer.createTransport(config);
    console.log("✅ Email transporter created:", provider);
    return transporter;
  } catch (error) {
    console.error("❌ Failed to create email transporter:", error.message);
    return null;
  }
};

// Default sender information
const defaultSender = {
  name: process.env.EMAIL_FROM_NAME || "Honk Hire Co.",
  email: process.env.EMAIL_FROM_ADDRESS || "noreply@honkhire.com",
};

module.exports = {
  createTransporter,
  defaultSender,
};
