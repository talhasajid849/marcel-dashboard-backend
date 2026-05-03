/**
 * Odometer Check Job - Thursday 9AM
 * Automatically request odometer readings from hirers
 */

const Hire = require('../models/Hire');
const Service = require('../models/Service');
const whatsappService = require('../services/whatsappService');
const { ODOMETER_CHECK_PROMPT, ODOMETER_FOLLOWUP_MESSAGE } = require('../services/marcel-prompts');

class OdometerCheckJob {
  constructor() {
    this.name = 'OdometerCheckJob';
    this.lastRun = null;
    this.checksReminded = 0;
    this.checksEscalated = 0;
  }

  hoursSince(value, now = new Date()) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return (now - date) / (1000 * 60 * 60);
  }

  async processDaveFollowUps() {
    const now = new Date();
    const openServices = await Service.find({
      status: 'SCHEDULED',
      mechanic_message_sent_at: { $exists: true, $nin: [null, ''] },
      mechanic_confirmed_at: { $in: [null, ''] },
    });

    let daveFollowUps = 0;
    let daveEscalations = 0;

    for (const service of openServices) {
      const hoursSinceMessage = this.hoursSince(service.mechanic_message_sent_at, now);
      if (hoursSinceMessage === null) continue;

      if (hoursSinceMessage >= 48 && !service.mechanic_escalated_at) {
        const escalationMsg = `⚠️ SERVICE ESCALATION: Dave has not confirmed this service after 48 hours.

Scooter: ${service.scooter_plate}
Hirer: ${service.hirer_name}
Phone: ${service.hirer_phone || service.hirer_whatsapp_id}
Location: ${service.service_location || 'TBC'}
Requested time: ${service.scheduled_date || 'TBC'} ${service.scheduled_time || ''}
Service ID: ${service.service_id}`;

        try {
          await whatsappService.sendMessage(process.env.COLE_WHATSAPP || '+61493654132', escalationMsg);
          service.mechanic_escalated_at = now.toISOString();
          service.updated_at = service.mechanic_escalated_at;
          await service.save();
          daveEscalations++;
        } catch (err) {
          console.error(`❌ Dave escalation failed for ${service.service_id}:`, err.message);
        }

        continue;
      }

      if (hoursSinceMessage >= 24 && !service.mechanic_followup_sent_at) {
        const followUpMsg = `Hey Dave, just following up on this service job.

Scooter: ${service.scooter_plate}
Hirer: ${service.hirer_name}
Location: ${service.service_location || 'TBC'}
Requested time: ${service.scheduled_date || 'TBC'} ${service.scheduled_time || ''}

Can you confirm you can make that work?

Cheers, Marcel`;

        try {
          await whatsappService.sendMessage(process.env.DAVE_WHATSAPP || '+61431398443', followUpMsg);
          service.mechanic_followup_sent_at = now.toISOString();
          service.updated_at = service.mechanic_followup_sent_at;
          await service.save();
          daveFollowUps++;
        } catch (err) {
          console.error(`❌ Dave follow-up failed for ${service.service_id}:`, err.message);
        }
      }
    }

    return { daveFollowUps, daveEscalations };
  }

  /**
   * Main execution - runs every Thursday 9AM
   */
  async execute() {
    const startTime = Date.now();
    console.log(`\n🔄 [${this.name}] Starting at ${new Date().toISOString()}`);

    try {
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0 = Sunday, 4 = Thursday

      // Find active hires that can actually receive WhatsApp odometer checks
      const activeHires = await Hire.find({
        status: 'ACTIVE',
        hirer_whatsapp_id: { $exists: true, $nin: [null, ''] },
      });

      console.log(`📋 Found ${activeHires.length} active hires`);

      let messagesSent = 0;
      let followUpsSent = 0;
      let escalations = 0;
      const daveResult = await this.processDaveFollowUps();

      for (const hire of activeHires) {
        const now = new Date();
        const todayDate = now.toISOString().split('T')[0];

        // THURSDAY 9AM CHECK
        if (dayOfWeek === 4) {
          // Check if already done today
          if (hire.last_thursday_check !== todayDate) {
            console.log(`📱 Sending Thursday check to ${hire.hirer_name} (${hire.scooter_plate})`);

            const message = ODOMETER_CHECK_PROMPT(hire.hirer_name, hire.scooter_plate);

            try {
              await whatsappService.sendMessage(
                hire.hirer_whatsapp_id,
                message,
                { hire_id: hire.hire_id }
              );

              hire.thursday_check_sent = now.toISOString();
              hire.last_thursday_check = todayDate;
              hire.thursday_check_responded = ''; // Reset response flag
              hire.thursday_reminder_sent = '';
              hire.escalated_to_cole = '';
              await hire.save();

              messagesSent++;
            } catch (err) {
              console.error(`❌ Failed to send to ${hire.hirer_name}:`, err.message);
            }
          }
        }

        // FRIDAY 5PM FOLLOW-UP (if no response)
        if (dayOfWeek === 5 && now.getHours() >= 17) {
          if (
            hire.thursday_check_sent &&
            !hire.thursday_check_responded &&
            !hire.thursday_reminder_sent
          ) {
            console.log(`📧 Sending Friday follow-up to ${hire.hirer_name}`);

            const followUpMsg = ODOMETER_FOLLOWUP_MESSAGE(hire.hirer_name);

            try {
              await whatsappService.sendMessage(
                hire.hirer_whatsapp_id,
                followUpMsg,
                { hire_id: hire.hire_id }
              );

              hire.thursday_reminder_sent = now.toISOString();
              await hire.save();

              followUpsSent++;
            } catch (err) {
              console.error(`❌ Follow-up failed for ${hire.hirer_name}:`, err.message);
            }
          }
        }

        // SATURDAY 12PM ESCALATION (if still no response)
        if (dayOfWeek === 6 && now.getHours() >= 12) {
          if (
            hire.thursday_check_sent &&
            !hire.thursday_check_responded &&
            !hire.escalated_to_cole
          ) {
            console.log(`⚠️ Escalating ${hire.hirer_name} to Cole`);

            // Message Cole
            const escalationMsg = `⚠️ ESCALATION: ${hire.hirer_name} (${hire.scooter_plate}) hasn't responded to Thursday odometer check. Sent Thursday 9am, followed up Friday 5pm. Please contact manually.

Hirer: ${hire.hirer_name}
Phone: ${hire.hirer_phone}
Scooter: ${hire.scooter_plate}
Hire ID: ${hire.hire_id}`;

            try {
              await whatsappService.sendMessage(
                process.env.COLE_WHATSAPP || '+61493654132',
                escalationMsg
              );

              hire.escalated_to_cole = now.toISOString();
              await hire.save();

              escalations++;
            } catch (err) {
              console.error(`❌ Escalation failed for ${hire.hirer_name}:`, err.message);
            }
          }
        }
      }

      const duration = Date.now() - startTime;

      console.log(`\n📊 [${this.name}] Summary:`);
      console.log(`   - Thursday checks sent: ${messagesSent}`);
      console.log(`   - Friday follow-ups: ${followUpsSent}`);
      console.log(`   - Escalations to Cole: ${escalations}`);
      console.log(`   - Dave follow-ups: ${daveResult.daveFollowUps}`);
      console.log(`   - Dave escalations: ${daveResult.daveEscalations}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`✅ [${this.name}] Completed\n`);

      this.lastRun = new Date();
      this.checksReminded += followUpsSent;
      this.checksEscalated += escalations;

      return {
        success: true,
        messagesSent,
        followUpsSent,
        escalations,
        daveFollowUps: daveResult.daveFollowUps,
        daveEscalations: daveResult.daveEscalations,
        duration,
      };
    } catch (error) {
      console.error(`❌ [${this.name}] Error:`, error.message);
      console.error(error.stack);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get job statistics
   */
  getStats() {
    return {
      name: this.name,
      lastRun: this.lastRun,
      checksReminded: this.checksReminded,
      checksEscalated: this.checksEscalated,
    };
  }
}

module.exports = new OdometerCheckJob();
