'use strict';

/**
 * Message Handler
 * ===============
 * Processes every incoming customer message.
 *
 * Handles 4 flows:
 *   1. Hirer sends odometer number (e.g. "3190")
 *      → logs reading → checks if service due → messages hirer + Dave
 *
 *   2. Hirer sends day/time/location for service
 *      → sends Dave full job booking message
 *
 *   3. Dave confirms he can make it
 *      → sends hirer confirmation
 *
 *   4. Dave sends "done" + odometer reading after service
 *      → logs service complete → updates next service due → messages hirer
 *
 * All other messages go through the Marcel AI (booking conversations).
 */

const Hire    = require('../models/Hire');
const Service = require('../models/Service');
const Message = require('../models/Message');
const { getReply } = require('./aiService');
const platformMessenger = require('./platformMessenger');
const bookingStateService = require('./bookingStateService');

const DAVE_WHATSAPP  = process.env.DAVE_WHATSAPP  || '+61431398443';
const COLE_WHATSAPP  = process.env.COLE_WHATSAPP  || '+61493654132';
const DAVE_CHAT_ID   = DAVE_WHATSAPP.replace(/^\+/, '') + '@c.us';

// ── Helpers ────────────────────────────────────────────────────────────────

function isFromDave(platformId) {
  return platformId === DAVE_CHAT_ID ||
         platformId === DAVE_WHATSAPP.replace(/^\+/, '') + '@c.us';
}

/**
 * Detect if message body is an odometer reading.
 * Accepts: "3190", "3,190", "3190km", "3190 km", "it's about 3190"
 * Returns the number or null.
 */
function extractOdometerReading(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, '').replace(/km/gi, '').trim();
  const match   = cleaned.match(/\b(\d{3,6})\b/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  // Sanity check: must be between 0 and 999999
  if (num < 0 || num > 999999) return null;
  return num;
}

/**
 * Detect if Dave is confirming he can do the job.
 * "yes", "yep", "sure", "confirmed", "i can make it", "no worries" etc.
 */
function isDaveConfirmation(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /\b(yes|yep|yeah|yup|sure|confirmed|confirm|can do|no worries|on my way|will do|sounds good|done deal|absolutely|affirmative)\b/.test(lower);
}

/**
 * Detect if Dave is reporting job done.
 * "done", "complete", "finished", "all done" + optionally a km reading.
 */
function isDaveJobDone(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /\b(done|complete|completed|finished|all done|job done|service done|sorted)\b/.test(lower);
}

async function findDaveServiceForReply(text) {
  const openServices = await Service.find({
    status: { $in: ['SCHEDULED', 'IN_PROGRESS'] },
  }).sort({ created_at: -1 });

  if (!openServices.length) return null;

  const lower = String(text || '').toLowerCase();
  const matched = openServices.find((service) => {
    const plate = String(service.scooter_plate || '').toLowerCase();
    return plate && lower.includes(plate);
  });

  if (matched) return matched;
  if (openServices.length === 1) return openServices[0];

  return { ambiguous: true, count: openServices.length };
}

/**
 * Build Dave's full job booking message (exact format from spec).
 */
function buildDaveJobMessage(hire, service) {
  return `Hey Dave, job ready for you.

Scooter:     ${hire.scooter_plate}
Hirer:       ${hire.hirer_name}
Address:     ${service.service_location || 'TBC'}
Phone:       ${hire.hirer_phone || hire.hirer_whatsapp_id}
Current km:  ${hire.current_odometer}
Service due: ${hire.next_service_due_km}km
Time:        ${service.scheduled_date || 'TBC'} at ${service.scheduled_time || 'TBC'}

Once you're done please reply with:
1. Confirmed complete
2. Odometer reading at time of service

Cheers, Marcel`;
}

/**
 * Build the message to hirer when service is due.
 */
function buildServiceDueMessage(hire) {
  return `Hey ${hire.hirer_name}, your scooter is coming up for its scheduled service at ${hire.next_service_due_km}km — you're nearly there! Our mechanic Dave will come to you wherever the bike is parked. Takes about 20 minutes and you won't need to go anywhere. What's a good day and time for you this week, and where will the bike be?`;
}

/**
 * Build confirmation message to hirer after Dave confirms.
 */
function buildHirerConfirmationMessage(hire, service) {
  return `All locked in! Dave will come to you on ${service.scheduled_date} at ${service.scheduled_time} at ${service.service_location}. He'll have you sorted in about 20 minutes — no need to do anything, just make sure the bike is accessible. See you then!`;
}

/**
 * Build post-service message to hirer.
 */
function buildServiceCompleteMessage(hire) {
  return `Hey ${hire.hirer_name}, all done! Dave has completed the service on your scooter. You're good to go — next service won't be due for another 2,000km. Enjoy the ride!`;
}

// ── Main handler ───────────────────────────────────────────────────────────

/**
 * processIncomingMessage
 * Called by channel services for every incoming message.
 * @param {Object} message - Saved Message document from DB
 */
async function processIncomingMessage(message) {
  const { platform = 'whatsapp', platform_id, message_body } = message;
  const text = (message_body || '').trim();

  console.log(`📨 Handler received: from=${platform_id} text="${text.substring(0, 80)}"`);

  if (/^(start over|restart|reset|new booking|start again)$/i.test(text)) {
    await bookingStateService.resetActiveBooking(platform, platform_id);
    await sendMessage(platform, platform_id, 'No worries, starting fresh. What are you planning to use the scooter for?');
    return;
  }

  // ── FLOW 1: Message from Dave ────────────────────────────────────────────
  if (isFromDave(platform_id)) {
    await handleDaveMessage(text, message);
    return;
  }

  // ── Find active hire for this hirer ─────────────────────────────────────
  const hire = platform === 'whatsapp'
    ? await Hire.findOne({
        hirer_whatsapp_id: platform_id,
        status: 'ACTIVE',
      })
    : null;

  if (hire) {
    // ── FLOW 2: Hirer sends odometer number ─────────────────────────────
    const odometerReading = extractOdometerReading(text);

    if (odometerReading !== null && hire.thursday_check_sent && !hire.thursday_check_responded) {
      await handleOdometerResponse(hire, odometerReading, message);
      return;
    }

    // ── FLOW 3: Hirer gives day/time/location for service ───────────────
    if (hire.service_needed && hire.service_booking_initiated && !hire.service_scheduled) {
      await handleServiceScheduling(hire, text, message);
      return;
    }
  }

  // ── FLOW 4: All other messages → Marcel AI (booking conversations) ──────
  await handleAIConversation(platform, platform_id, text, message, hire);
}

async function sendMessage(platform, to, text, messageData = {}) {
  return platformMessenger.sendMessage(platform, to, text, messageData);
}

function looksLikeInternalReply(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;

  return [
    "i'll save",
    'i will save',
    'let me save',
    'save the details',
    'save these details',
    'save the delivery option',
    'save_booking_field',
    'booking status',
    'tool call',
    'the customer provided',
    'the user provided',
  ].some(pattern => value.includes(pattern));
}

async function buildAIContext(platform, platformId, hire) {
  const { state: bookingState, customer } = await bookingStateService.loadState(platform, platformId);
  let customerContext = bookingStateService.buildBookingContext(bookingState, customer);

  if (hire) {
    customerContext += `\nACTIVE HIRE:\n`;
    customerContext += `Scooter: ${hire.scooter_plate} (${hire.scooter_type})\n`;
    customerContext += `Current odometer: ${hire.current_odometer || 'unknown'}km\n`;
    customerContext += `Next service due: ${hire.next_service_due_km}km\n`;
    customerContext += `Hire started: ${hire.hire_start_date}\n`;
    customerContext += `Hire ends: ${hire.hire_end_date}\n`;
  }

  return customerContext;
}

async function fallbackReply(platform, platformId) {
  const { state } = await bookingStateService.loadState(platform, platformId);
  return bookingStateService.buildNextQuestion(state);
}

function isPaymentCheckMessage(text) {
  return /\b(i\s+have\s+(paid|payed|apid)|i\s+paid|paid|payed|apid|payment\s+(done|sent|made)|check\s+(payment|paid))\b/i.test(String(text || ''));
}

async function bookingProgressReply(platform, platformId) {
  const finalization = await bookingStateService.finalizeBookingIfReady(platform, platformId);

  // Booking already paid — customer is asking a post-payment question
  // Do NOT send payment link again — let AI answer naturally
  if (finalization.alreadyPaid) {
    return null; // null tells the caller to use AI reply directly
  }

  if (finalization.ok && finalization.paymentLink) {
    const booking = finalization.booking || {};
    const weeklyRate = finalization.pricing?.weeklyRate || booking.weekly_rate || (booking.scooter_type === '125cc' ? 160 : 150);
    const deposit = finalization.pricing?.deposit || booking.deposit || 300;
    const deliveryFee = finalization.pricing?.deliveryFee ?? booking.delivery_fee ?? (booking.pickup_delivery === 'delivery' ? 40 : 0);
    const amountUpfront = finalization.amountUpfront || booking.amount_upfront || (weeklyRate + deposit + deliveryFee);

    return [
      `Thanks, we have everything now. Your upfront payment is $${amountUpfront}.`,
      `That includes $${weeklyRate} for the first week, $${deposit} refundable deposit${deliveryFee ? `, and $${deliveryFee} delivery` : ''}.`,
      `After that it is $${weeklyRate} per week while you have the scooter.`,
      `Payment link: ${finalization.paymentLink}`,
    ].join('\n\n');
  }

  if (finalization.ready && !finalization.ok) {
    console.error('Payment link generation failed:', finalization.reason);
    if (finalization.noAvailability) {
      return `${finalization.reason} I will check with the team and come back with the closest option.`;
    }
    return 'Thanks, we have everything now. I could not create the payment link automatically, so the team will send it through shortly.';
  }

  return fallbackReply(platform, platformId);
}

// ── Flow handlers ──────────────────────────────────────────────────────────

/**
 * FLOW 1: Handle message from Dave
 */
async function handleDaveMessage(text, message) {
  console.log(`🔧 Message from Dave: "${text.substring(0, 80)}"`);

  // Find the service Dave is replying about. If multiple jobs are open, require scooter rego.
  const service = await findDaveServiceForReply(text);

  if (service?.ambiguous) {
    await sendMessage(
      message.platform,
      DAVE_WHATSAPP,
      `I have ${service.count} open service jobs. Please reply with the scooter rego as well, for example: "Done ABC123 3205km".`
    );
    return;
  }

  if (!service) {
    console.log('ℹ️  No scheduled service found for Dave message');
    return;
  }

  const hire = await Hire.findOne({ hire_id: service.hire_id });

  // Dave says job is DONE
  if (isDaveJobDone(text)) {
    const odometerReading = extractOdometerReading(text);

    // Update service record
    const now = new Date().toISOString();
    service.status               = 'COMPLETED';
    service.service_completed_at = now;
    service.updated_at           = now;

    if (odometerReading) {
      service.odometer_at_service  = odometerReading;
      service.next_service_due_km  = odometerReading + 2000;
    }

    await service.save();

    // Update hire record
    if (hire) {
      hire.service_needed           = false;
      hire.service_scheduled        = false;
      hire.service_booking_initiated = '';
      hire.current_odometer         = odometerReading || hire.current_odometer;
      hire.next_service_due_km      = odometerReading
        ? odometerReading + 2000
        : hire.next_service_due_km;
      // Reset Thursday check flags so cycle continues
      hire.thursday_check_responded  = now;
      hire.thursday_check_sent       = '';
      hire.thursday_reminder_sent    = '';
      hire.escalated_to_cole         = '';
      hire.updated_at                = now;
      await hire.save();

      const Fleet = require('../models/Fleet');
      await Fleet.findOneAndUpdate(
        { scooter_plate: hire.scooter_plate },
        {
          $set: {
            odometer_km: hire.current_odometer,
            next_service_due: String(hire.next_service_due_km),
            updated_at: now,
          },
        }
      );

      // Message hirer — service complete
      const hirerMsg = buildServiceCompleteMessage(hire);
      await sendMessage(message.platform, hire.hirer_whatsapp_id, hirerMsg);
      console.log(`✅ Service complete. Next service due: ${hire.next_service_due_km}km`);
    }

    return;
  }

  // Dave CONFIRMS he can make the job
  if (isDaveConfirmation(text)) {
    if (!hire) return;

    // Update service as confirmed by mechanic
    service.status = 'IN_PROGRESS';
    service.mechanic_confirmed_at = new Date().toISOString();
    await service.save();

    // Message hirer with confirmation
    const confirmMsg = buildHirerConfirmationMessage(hire, service);
    await sendMessage(message.platform, hire.hirer_whatsapp_id, confirmMsg);

    console.log(`✅ Dave confirmed — hirer ${hire.hirer_name} notified`);
    return;
  }

  // Dave sent something else — check if escalation needed after 24h/48h
  console.log(`ℹ️  Dave message not matched as confirmation or done: "${text}"`);
}

/**
 * FLOW 2: Hirer responds with odometer reading
 */
async function handleOdometerResponse(hire, reading, message) {
  console.log(`📏 Odometer reading from ${hire.hirer_name}: ${reading}km`);

  // Mark Thursday check as responded
  hire.thursday_check_responded = new Date().toISOString();
  await hire.addOdometerReading(reading, 'THURSDAY_CHECK');

  const kmUntilService = hire.next_service_due_km - reading;
  console.log(`   Next service due: ${hire.next_service_due_km}km | km until service: ${kmUntilService}km`);

  // Check if within 200km of service — trigger service booking
  if (kmUntilService <= 200) {
    console.log(`⚠️  Service due soon! Triggering service booking for ${hire.scooter_plate}`);

    // Create service record
    const service = new Service({
      service_id:          'SVC-' + Date.now(),
      scooter_plate:       hire.scooter_plate,
      scooter_type:        hire.scooter_type,
      service_type:        'REGULAR_2000KM',
      hire_id:             hire.hire_id,
      hirer_name:          hire.hirer_name,
      hirer_phone:         hire.hirer_phone,
      hirer_whatsapp_id:   hire.hirer_whatsapp_id,
      previous_service_km: hire.current_odometer,
      next_service_due_km: hire.next_service_due_km,
      mechanic_name:       'Dave',
      mechanic_phone:      DAVE_WHATSAPP,
      status:              'SCHEDULED',
    });
    await service.save();

    // Mark hire as service booking initiated
    hire.service_needed            = true;
    hire.service_booking_initiated = new Date().toISOString();
    hire.service_id                = service.service_id;
    await hire.save();

    // Message hirer — ask for day/time/location
    const hirerMsg = buildServiceDueMessage(hire);
    await sendMessage(message.platform, hire.hirer_whatsapp_id, hirerMsg);

    console.log(`✅ Service due message sent to ${hire.hirer_name}`);
  } else {
    // Not due yet — just log and confirm
    console.log(`✅ Reading logged. ${kmUntilService}km until next service.`);
    // No reply needed — just log it silently as per spec
  }
}

/**
 * FLOW 3: Hirer gives day/time/location for service
 */
async function handleServiceScheduling(hire, text, message) {
  console.log(`📅 Service scheduling response from ${hire.hirer_name}: "${text}"`);

  // Find the pending service record
  const service = await Service.findOne({
    hire_id: hire.hire_id,
    status:  'SCHEDULED',
  });

  if (!service) {
    console.log('ℹ️  No scheduled service found');
    return;
  }

  // Parse day/time/location from hirer's message
  // We store the raw text and let the message speak for itself to Dave
  // Simple parsing — look for day names and times
  const dayMatch  = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i);
  const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);

  service.scheduled_date    = dayMatch  ? dayMatch[0]  : text;
  service.scheduled_time    = timeMatch ? timeMatch[0] : 'TBC';
  service.service_location  = text; // store full response as location for Dave
  service.updated_at        = new Date().toISOString();
  await service.save();

  // Mark hire as scheduled
  hire.service_scheduled = true;
  await hire.save();

  // Message Dave with full job details
  const daveMsg = buildDaveJobMessage(hire, service);
  await sendMessage(message.platform, DAVE_WHATSAPP, daveMsg);
  service.mechanic_message_sent_at = new Date().toISOString();
  service.updated_at = service.mechanic_message_sent_at;
  await service.save();

  console.log(`✅ Dave messaged with job details for ${hire.scooter_plate}`);
}

/**
 * FLOW 4: Regular AI conversation (bookings, enquiries, etc.)
 */
async function handleAIConversation(platform, platformId, text, message, hire) {
  try {
    // Pre-fill known fields for returning customers (runs fast, only updates if needed)
    await bookingStateService.prefillFromCustomerProfile(platform, platformId).catch(() => {});

    if (message.media_url) {
      const photoSave = await bookingStateService.saveLicencePhoto(platform, platformId, message.media_url);

      if (photoSave?.ok) {
        message.ai_processed = true;
        message.ai_extracted_data = {
          ...(message.ai_extracted_data || {}),
          licencePhoto: {
            field: photoSave.field,
            url: photoSave.value,
          },
        };
        await message.save();

        const replyText = await bookingProgressReply(platform, platformId);
        if (replyText) {
          await sendMessage(platform, platformId, replyText);
        }
        console.log(`✅ Licence photo URL saved for ${platformId}: ${photoSave.field}`);
        return;
      }

      await sendMessage(platform, platformId, photoSave?.reason || 'I could not save that licence photo. Please send it again.');
      console.log(`✅ Licence photo validation reply sent to ${platformId}`);
      return;
    }

    if (!text) {
      console.log(`ℹ️  Empty non-media message ignored for ${platformId}`);
      return;
    }

    if (isPaymentCheckMessage(text)) {
      const { booking } = await bookingStateService.loadState(platform, platformId);
      const isPaid = booking?.payment_status === 'PAID' || booking?.status === 'CONFIRMED';
      const replyText = isPaid
        ? 'Thanks, I can see your payment has been received and your booking is confirmed.'
        : "Thanks for letting me know. I can't see the payment confirmed in the system yet. It can take a minute after checkout; once Stripe confirms it, I'll send the booking confirmation automatically.";

      await sendMessage(platform, platformId, replyText);
      console.log(`✅ Payment status reply sent to ${platformId}`);
      return;
    }

    const progressReply = await bookingProgressReply(platform, platformId);

    // null means booking is confirmed - skip payment logic, let AI handle naturally.
    if (
      progressReply !== null &&
      /payment link|pay|payment|link/i.test(text) &&
      !progressReply.includes('What are you planning')
    ) {
      await sendMessage(platform, platformId, progressReply);
      console.log(`Booking progress/payment reply sent to ${platformId}`);
      return;
    }

    const fallbackSave = await bookingStateService.applyExpectedFieldFallback(platform, platformId, text);

    if (fallbackSave?.ok) {
      message.ai_processed = true;
      message.ai_extracted_data = {
        ...(message.ai_extracted_data || {}),
        deterministicSave: {
          field: fallbackSave.field,
          value: fallbackSave.value,
        },
      };
      await message.save();

      const replyText = await bookingProgressReply(platform, platformId);
      if (replyText) {
        await sendMessage(platform, platformId, replyText);
      }
      console.log(`✅ Deterministic booking reply sent to ${platformId}`);
      return;
    }

    if (fallbackSave && fallbackSave.ok === false && fallbackSave.reason) {
      await sendMessage(platform, platformId, fallbackSave.reason);
      console.log(`✅ Deterministic validation reply sent to ${platformId}`);
      return;
    }

    // Get last 20 messages for context
    const history = await Message.find({ platform, platform_id: platformId })
      .sort({ created_at: -1 })
      .limit(20)
      .lean();

    const conversationMessages = history
      .reverse()
      .filter(m => String(m.message_body || '').trim())
      .map(m => ({
        role:    m.direction === 'INCOMING' ? 'user' : 'assistant',
        content: m.message_body,
      }));

    let customerContext = await buildAIContext(platform, platformId, hire);
    let result = await getReply(conversationMessages, customerContext);
    let savedFields = [];
    let rejectedFields = [];

    if (result?.toolCalls?.length) {
      const applied = await bookingStateService.applyToolCalls(platform, platformId, result.toolCalls);
      savedFields = applied.saved;
      rejectedFields = applied.rejected;
      message.ai_processed = true;
      message.ai_extracted_data = {
        ...(message.ai_extracted_data || {}),
        savedBookingFields: savedFields,
        rejectedBookingFields: rejectedFields,
      };
      await message.save();

      if (savedFields.length) {
        console.log('✅ Booking fields saved:', savedFields);
      }
      if (rejectedFields.length) {
        console.warn('⚠️  Booking fields rejected:', rejectedFields);
      }
    }

    if (savedFields.length) {
      result = { text: await bookingProgressReply(platform, platformId) };
    } else if (result?.text) {
      await bookingStateService.inferFromAssistantReply(platform, platformId, result.text);
    }

    if (!result || !result.text) {
      console.log('ℹ️  AI returned no reply; using deterministic next question');
      result = { text: await fallbackReply(platform, platformId) };
    }

    let replyText = result.text;
    if (looksLikeInternalReply(replyText)) {
      console.warn('⚠️  Blocked internal AI reply:', replyText);
      replyText = await fallbackReply(platform, platformId);
    }

    // Send reply
    await sendMessage(platform, platformId, replyText);
    console.log(`✅ AI reply sent to ${platformId}`);

  } catch (err) {
    console.error('❌ AI conversation error:', err.message);
  }
}

module.exports = { processIncomingMessage };
