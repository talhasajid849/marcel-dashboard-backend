/**
 * Email Service - Reusable & Scalable
 * Handles all email sending with EJS templates
 */

const path = require('path');
const ejs = require('ejs');
const { createTransporter, defaultSender } = require('../utils/emailConfig');

class EmailService {
  constructor() {
    this.transporter = createTransporter();
    this.templatesPath = path.join(__dirname, '../templates/emails');
  }

  /**
   * Render EJS template with data
   */
  async renderTemplate(templateName, data) {
    try {
      const templatePath = path.join(this.templatesPath, `${templateName}.ejs`);
      const html = await ejs.renderFile(templatePath, {
        ...data,
        currentYear: new Date().getFullYear(),
        companyName: process.env.EMAIL_FROM_NAME || 'Honk Hire Co.',
        companyEmail: defaultSender.email,
        companyPhone: process.env.COMPANY_PHONE || '+61 493 654 132',
        companyWebsite: process.env.COMPANY_WEBSITE || process.env.FRONTEND_URL || 'https://honkhire.com.au',
      });
      return html;
    } catch (error) {
      console.error('Template rendering error:', error.message);
      throw new Error(`Failed to render template: ${templateName}`);
    }
  }

  /**
   * Send email with template
   */
  async sendEmail({ to, subject, template, data, attachments = [] }) {
    if (!this.transporter) {
      console.error('Email transporter not configured');
      return { success: false, error: 'Email not configured' };
    }

    try {
      // Render HTML template
      const html = await this.renderTemplate(template, data);

      // Email options
      const mailOptions = {
        from: `${defaultSender.name} <${defaultSender.email}>`,
        to,
        subject,
        html,
        attachments,
      };

      // Send email
      const info = await this.transporter.sendMail(mailOptions);

      console.log('✅ Email sent:', {
        to,
        subject,
        template,
        messageId: info.messageId,
      });

      return {
        success: true,
        messageId: info.messageId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('❌ Email send error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Send Booking Confirmation Email
   */
  async sendBookingConfirmation(booking) {
    return this.sendEmail({
      to: booking.email,
      subject: `Booking Confirmed - ${booking.booking_id}`,
      template: 'booking-confirmed',
      data: {
        customerName: booking.name,
        bookingId: booking.booking_id,
        scooterType: booking.scooter_type,
        scooterPlate: booking.scooter_plate,
        startDate: booking.start_date,
        endDate: booking.end_date,
        amount: booking.amount_upfront,
        pickupAddress: booking.delivery_address || 'Our main office',
      },
    });
  }

  /**
   * Send Booking Cancelled Email
   */
  async sendBookingCancellation(booking, reason) {
    return this.sendEmail({
      to: booking.email,
      subject: `Booking Cancelled - ${booking.booking_id}`,
      template: 'booking-cancelled',
      data: {
        customerName: booking.name,
        bookingId: booking.booking_id,
        reason: reason || 'No reason provided',
        refundAmount: booking.amount_upfront,
      },
    });
  }

  /**
   * Send Booking Pending Email
   */
  async sendBookingPending(booking) {
    return this.sendEmail({
      to: booking.email,
      subject: `Booking Received - ${booking.booking_id}`,
      template: 'booking-pending',
      data: {
        customerName: booking.name,
        bookingId: booking.booking_id,
        scooterType: booking.scooter_type,
        startDate: booking.start_date,
        endDate: booking.end_date,
      },
    });
  }

  /**
   * Send Payment Reminder Email
   */
  async sendPaymentReminder(booking) {
    return this.sendEmail({
      to: booking.email,
      subject: `Payment Reminder - ${booking.booking_id}`,
      template: 'payment-reminder',
      data: {
        customerName: booking.name,
        bookingId: booking.booking_id,
        amount: booking.amount_upfront,
        paymentLink: booking.stripe_link,
        expiresAt: booking.hold_expires_at,
      },
    });
  }

  /**
   * Send Welcome Email (for new customers)
   */
  async sendWelcomeEmail(customer) {
    return this.sendEmail({
      to: customer.email,
      subject: 'Welcome to Honk Hire Co.!',
      template: 'welcome',
      data: {
        customerName: customer.name,
        customerId: customer.customer_id,
      },
    });
  }
}

// Export singleton instance
module.exports = new EmailService();
