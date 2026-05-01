"use strict";

const Booking = require("../models/Booking");
const Customer = require("../models/Customer");
const Fleet = require("../models/Fleet");
const stripeService = require("./stripeService");
const pricingService = require("./pricingService");

const HOLD_DURATION_HOURS = Number(process.env.PAYMENT_HOLD_HOURS || 3);

const FIELD_TO_BOOKING_FIELD = {
  scooterType: "scooter_type",
  licenceType: "licence_type",
  startDate: "start_date",
  endDate: "end_date",
  pickupOrDelivery: "pickup_delivery",
  countryOfOrigin: "country_of_origin",
  address: "address",
  name: "name",
  phone: "phone",
  email: "email",
  nextOfKin: "next_of_kin",
  nextOfKinPhone: "next_of_kin_phone",
  licencePhotoFrontUrl: "licence_photo_front_url",
  licencePhotoBackUrl: "licence_photo_back_url",
};

const CUSTOMER_FIELDS = {
  countryOfOrigin: "country_of_origin",
  address: "address",
  name: "name",
  phone: "phone",
  email: "email",
  nextOfKin: "next_of_kin",
  nextOfKinPhone: "next_of_kin_phone",
  licenceType: "licence_type",
  licencePhotoFrontUrl: "licence_photo_front_url",
  licencePhotoBackUrl: "licence_photo_back_url",
};

const FIELD_ALIASES = {
  licencePhotoFrontUrl: ["license_photo_front_url"],
  licencePhotoBackUrl: ["license_photo_back_url"],
};

function valueOf(booking, customer, field) {
  const bookingField = FIELD_TO_BOOKING_FIELD[field];
  const customerField = CUSTOMER_FIELDS[field];
  const aliases = FIELD_ALIASES[field] || [];

  return (
    booking?.[bookingField] ||
    customer?.[customerField] ||
    aliases
      .map((alias) => booking?.[alias] || customer?.[alias])
      .find(Boolean) ||
    ""
  );
}

function hasStreetNumber(value) {
  return /\b\d+[a-zA-Z]?(?:\s*\/\s*\d+[a-zA-Z]?)?\b/.test(String(value || ""));
}

function completeAddress(value) {
  const address = String(value || "").trim();
  return address && hasStreetNumber(address) ? address : "";
}

function toState(booking, customer) {
  const licencePhotoFrontUrl = valueOf(
    booking,
    customer,
    "licencePhotoFrontUrl",
  );
  const licencePhotoBackUrl = valueOf(booking, customer, "licencePhotoBackUrl");

  return {
    bookingId: booking?.booking_id || "",
    scooterType: valueOf(booking, customer, "scooterType"),
    licenceType: valueOf(booking, customer, "licenceType"),
    startDate: valueOf(booking, customer, "startDate"),
    endDate: valueOf(booking, customer, "endDate"),
    pickupOrDelivery: valueOf(booking, customer, "pickupOrDelivery"),
    countryOfOrigin: valueOf(booking, customer, "countryOfOrigin"),
    address: completeAddress(valueOf(booking, customer, "address")),
    name: valueOf(booking, customer, "name"),
    phone: valueOf(booking, customer, "phone"),
    email: valueOf(booking, customer, "email"),
    nextOfKin: valueOf(booking, customer, "nextOfKin"),
    nextOfKinPhone: valueOf(booking, customer, "nextOfKinPhone"),
    licencePhotoFrontReceived: !!licencePhotoFrontUrl,
    licencePhotoBackReceived: !!licencePhotoBackUrl,
    licencePhotoFrontUrl,
    licencePhotoBackUrl,
    paymentLink: booking?.stripe_link || "",
    amountUpfront: booking?.amount_upfront || "",
    status: booking?.status || "",
    paymentStatus: booking?.payment_status || "",
  };
}

function nextField(state) {
  if (!state.scooterType) return "scooterType";
  if (!state.licenceType) return "licenceType";
  if (!state.startDate || !state.endDate) return "dates";
  if (!state.pickupOrDelivery) return "pickupOrDelivery";
  if (!state.countryOfOrigin) return "countryOfOrigin";
  if (!state.address) return "address";
  if (!state.name) return "name";
  if (!state.phone) return "phone";
  if (!state.email) return "email";
  if (!state.nextOfKin) return "nextOfKin";
  if (!state.nextOfKinPhone) return "nextOfKinPhone";
  if (!state.licencePhotoFrontReceived) return "licencePhotoFront";
  if (!state.licencePhotoBackReceived) return "licencePhotoBack";
  return null;
}

function buildBookingContext(state, customer = null) {
  const missing = nextField(state);

  const pricing = pricingService.quote(state.scooterType, state.pickupOrDelivery);

  // Build customer history section
  const tier = customer?.customer_tier || "NEW";
  const totalHires = customer?.total_hires || 0;
  const totalSpent = customer?.total_spent || 0;
  const isReturning = totalHires > 0;
  const name = customer?.name || state.name || "";

  const customerLines = [
    "",
    "# CUSTOMER HISTORY",
    "",
    `Customer tier: ${tier}`,
    `Previous hires: ${totalHires}`,
    `Total spent: $${totalSpent}`,
    `Returning customer: ${isReturning ? "YES" : "NO"}`,
  ];

  if (isReturning && name) {
    customerLines.push(`Known name: ${name}`);
    customerLines.push("");
    customerLines.push(
      "IMPORTANT: This is a returning customer. Greet them warmly by name.",
    );
    customerLines.push(
      "Skip explaining basic info they already know (pricing, how it works).",
    );
    customerLines.push(
      "Just confirm what they need and move quickly to dates/scooter type.",
    );
    if (tier === "REGULAR" || tier === "VIP") {
      customerLines.push(
        `They are a ${tier} customer — treat them as a valued regular.`,
      );
      customerLines.push("Be extra warm and friendly. They know the process.");
    }
  }

  if (customer?.licence_photo_front_url && customer?.licence_photo_back_url) {
    customerLines.push(
      "Licence photos: ALREADY ON FILE — do not ask for licence photos again.",
    );
  }

  if (customer?.country_of_origin) {
    customerLines.push(
      `Country on file: ${customer.country_of_origin} — do not ask again.`,
    );
  }

  if (customer?.address) {
    customerLines.push(
      `Address on file: ${customer.address} — do not ask again.`,
    );
  }
  const lines = [
    "# BOOKING STATUS",
    "",
    `Current date: ${new Date().toISOString().split("T")[0]} (year is ${new Date().getFullYear()})`,
    `Timezone: Australia/Brisbane`,
    ``,
    `Booking ID: ${state.bookingId || "NOT CREATED YET"}`,
    `Scooter type: ${state.scooterType || "NOT SET"}`,
    "",
    "# CORRECT PRICING (use these exact numbers, do not guess)",
    `First week payment: $${pricing.firstWeekRate}`,
    `Weekly renewal after week 1: $${pricing.weeklyRate}/week`,
    `Deposit: $${pricing.deposit} refundable`,
    `Delivery fee: $${pricing.deliveryFee}`,
    `Upfront total: $${pricing.amountUpfront} (first week payment + deposit${pricing.deliveryFee ? " + delivery" : ""})`,
    "",
    ...customerLines,
    `Licence type: ${state.licenceType || "NOT SET"}`,
    `Dates: ${state.startDate && state.endDate ? `${state.startDate} to ${state.endDate}` : "NOT SET"}`,
    `Pickup or delivery: ${state.pickupOrDelivery || "NOT SET"}`,
    `Country: ${state.countryOfOrigin || "NOT SET"}`,
    `Address: ${state.address || "NOT SET"}`,
    `Name: ${state.name || "NOT SET"}`,
    `Phone: ${state.phone || "NOT SET"}`,
    `Email: ${state.email || "NOT SET"}`,
    `Next of kin: ${state.nextOfKin || "NOT SET"}`,
    `Next of kin phone: ${state.nextOfKinPhone || "NOT SET"}`,
    `Licence photo front: ${state.licencePhotoFrontReceived ? "RECEIVED" : "NOT RECEIVED"}`,
    `Licence photo back: ${state.licencePhotoBackReceived ? "RECEIVED" : "NOT RECEIVED"}`,
  ];

  if (state.paymentLink) {
    lines.push(`Payment link: ${state.paymentLink}`);
  }

  lines.push("", "# WHAT TO DO NEXT", "");

  const instructions = {
    scooterType:
      "Understand the customer need, recommend 50cc or 125cc if clear, then ask/confirm the scooter type.",
    licenceType:
      "Ask for the licence type needed for the scooter. 50cc needs a car licence. 125cc needs a full motorcycle licence.",
    dates: "Ask for both start date and end date. Minimum 1 week.",
    pickupOrDelivery: "Ask if they want pickup or delivery.",
    countryOfOrigin: "Ask what country they are from for insurance.",
    address:
      "Ask for their full Sunshine Coast address, including the house or unit number.",
    name: "Ask for their name.",
    phone: "Ask for their mobile number.",
    email: "Ask for their email address.",
    nextOfKin: "Ask for their emergency contact name.",
    nextOfKinPhone: "Ask for their emergency contact phone number.",
    licencePhotoFront:
      "Ask them to send a photo of the front of their licence.",
    licencePhotoBack: "Ask them to send a photo of the back of their licence.",
  };

  if (state.status === "CONFIRMED" || state.paymentStatus === "PAID") {
    lines.push("");
    lines.push("# BOOKING IS CONFIRMED AND PAID");
    lines.push("");
    lines.push("The customer has already paid and their booking is confirmed.");
    lines.push("Do NOT ask for any booking details.");
    lines.push("Do NOT send any payment links.");
    lines.push("Do NOT start a new booking.");
    lines.push("Just answer their questions naturally and helpfully.");
    lines.push("If they ask about their booking, confirm the details above.");
    lines.push(
      "If they have a problem or emergency, direct them to Cole on 0493 654 132.",
    );
  } else {
    lines.push(
      missing
        ? instructions[missing]
        : "All booking details are collected. Do not ask for more details.",
    );
    lines.push("Never ask again for a field marked with a value above.");
  }
  return lines.join("\n");
}

function buildNextQuestion(state) {
  const missing = nextField(state);

  const questions = {
    scooterType: "What are you planning to use it for?",
    licenceType:
      state.scooterType === "125cc"
        ? "For the 125cc you need a full motorcycle licence. Do you have one?"
        : "For the 50cc you just need a regular car licence. Do you have one?",
    dates: "What dates do you need it for?",
    pickupOrDelivery:
      "Pickup from Tewantin or Maroochydore, or delivery for $40?",
    countryOfOrigin: "What country are you from for insurance?",
    address:
      "What is your full Sunshine Coast address, including house or unit number?",
    name: "What is your name?",
    phone: "Best Australian mobile number for you?",
    email: "What email should we use?",
    nextOfKin: "Who is your emergency contact?",
    nextOfKinPhone: "What is their Australian mobile number?",
    licencePhotoFront:
      "Send through a photo of the front of your licence when you are ready.",
    licencePhotoBack:
      "Got the front. Send the back of your licence when you are ready.",
  };

  return missing
    ? questions[missing] || "What is the next detail?"
    : "Thanks, we have all the details now. We will review everything and send the payment link shortly.";
}

function sanitizeValue(field, value) {
  const v = String(value || "").trim();
  if (!v) return "";

  if (field === "scooterType") {
    if (/125/.test(v)) return "125cc";
    if (/50/.test(v)) return "50cc";
    return "";
  }

  if (field === "licenceType") {
    if (/motor/i.test(v)) return "motorcycle";
    if (/car|driver|licen/i.test(v)) return "car";
    return "";
  }

  if (field === "pickupOrDelivery") {
    if (/deliver/i.test(v)) return "delivery";
    if (/pickup|pick up|collect/i.test(v)) return "pickup";
    return "";
  }

  if (field === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
  }

  if (field === "phone" || field === "nextOfKinPhone") {
    const compact = v.replace(/[^\d+]/g, "");
    if (/^04\d{8}$/.test(compact)) return compact;
    if (/^614\d{8}$/.test(compact)) return `+${compact}`;
    if (/^\+614\d{8}$/.test(compact)) return compact;
    return "";
  }

  if (field === "licencePhotoFrontUrl" || field === "licencePhotoBackUrl") {
    return /^https?:\/\//i.test(v) ? v : "";
  }

  if (field === "address") {
    return completeAddress(v);
  }

  return v;
}

function parseDateInput(text) {
  const raw = String(text || "")
    .toLowerCase()
    .replace(/aprail/g, "april");
  const monthMap = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const datePattern = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?/gi;
  const matches = [...raw.matchAll(datePattern)];

  if (matches.length < 2) return null;

  const now = new Date();
  const currentYear = now.getFullYear(); // Always 2026
  const currentMonth = now.getMonth() + 1;

  const parsed = matches.slice(0, 2).map((match) => {
    const day = Number(match[1]);
    const month = monthMap[match[2]];
    let year = Number(match[3] || currentYear);

    // If no year given and month is in the past, use next year
    if (!match[3] && month < currentMonth - 1) {
      year = currentYear + 1;
    }

    if (!day || !month || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });

  if (!parsed[0] || !parsed[1]) return null;
  return { startDate: parsed[0], endDate: parsed[1] };
}

function parseToolCall(toolCall) {
  if (!toolCall || toolCall.name !== "save_booking_field") return null;

  let input = toolCall.input;
  if (!input && toolCall.arguments) {
    try {
      input = JSON.parse(toolCall.arguments);
    } catch {
      input = null;
    }
  }

  if (!input?.field) return null;
  return {
    field: input.field,
    value: input.value,
  };
}

async function findCustomer(platform, platformId) {
  return Customer.findOne({ platform, platform_id: platformId });
}

async function findActiveBooking(platform, platformId) {
  return Booking.findOne({
    platform,
    platform_id: platformId,
    status: { $in: ["PENDING", "HELD_AWAITING_PAYMENT", "CONFIRMED"] },
    payment_status: { $ne: "EXPIRED" },
  }).sort({ created_at: -1 });
}

async function ensureCustomer(platform, platformId, state = {}) {
  const now = new Date().toISOString();
  const customerId = state.customer_id || `CUS-${Date.now()}`;

  return Customer.findOneAndUpdate(
    { platform, platform_id: platformId },
    {
      $setOnInsert: {
        customer_id: customerId,
        platform,
        platform_id: platformId,
        customer_tier: "NEW",
        total_bookings: 0,
        successful_bookings: 0,
        total_hires: 0,
        total_spent: 0,
        created_at: now,
      },
      $set: {
        last_contact: now,
        updated_at: now,
      },
    },
    { upsert: true, new: true },
  );
}

/**
 * For returning customers — pre-fill booking fields from their profile
 * so Marcel doesn't ask for info we already have
 */
async function prefillFromCustomerProfile(platform, platformId) {
  const customer = await findCustomer(platform, platformId);
  if (!customer) return;

  const { booking } = await loadState(platform, platformId);
  if (!booking) return;

  const now = new Date().toISOString();
  const updates = {};

  // Prefill fields we already know about them
  const customerName = customer.name || customer.full_name || "";
  if (customerName && !booking.name) updates.name = customerName;
  if (customer.phone && !booking.phone) updates.phone = customer.phone;
  if (customer.email && !booking.email) updates.email = customer.email;
  if (completeAddress(customer.address) && !booking.address) {
    updates.address = completeAddress(customer.address);
  }
  if (customer.country_of_origin && !booking.country_of_origin)
    updates.country_of_origin = customer.country_of_origin;
  if (customer.next_of_kin && !booking.next_of_kin)
    updates.next_of_kin = customer.next_of_kin;
  if (customer.next_of_kin_phone && !booking.next_of_kin_phone)
    updates.next_of_kin_phone = customer.next_of_kin_phone;
  if (customer.licence_type && !booking.licence_type)
    updates.licence_type = customer.licence_type;

  // Licence photos — returning customer can reuse previous photos
  if (customer.licence_photo_front_url && !booking.licence_photo_front_url) {
    updates.licence_photo_front_url = customer.licence_photo_front_url;
    updates.license_photo_front_url = customer.licence_photo_front_url;
  }
  if (customer.licence_photo_back_url && !booking.licence_photo_back_url) {
    updates.licence_photo_back_url = customer.licence_photo_back_url;
    updates.license_photo_back_url = customer.licence_photo_back_url;
  }

  if (Object.keys(updates).length === 0) return;

  updates.updated_at = now;
  await Booking.findOneAndUpdate(
    { booking_id: booking.booking_id },
    { $set: updates },
  );

  console.log(
    `✅ Pre-filled ${Object.keys(updates).length} fields for returning customer:`,
    customer.name,
  );
}

async function ensureBooking(platform, platformId, customer) {
  const existing = await findActiveBooking(platform, platformId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const frontLicenceUrl =
    customer?.licence_photo_front_url ||
    customer?.license_photo_front_url ||
    "";
  const backLicenceUrl =
    customer?.licence_photo_back_url || customer?.license_photo_back_url || "";

  return Booking.create({
    booking_id: `HHC-${Date.now()}`,
    customer_id: customer?.customer_id || "",
    platform,
    platform_id: platformId,
    name: customer?.name || customer?.full_name || "",
    phone: customer?.phone || "",
    email: customer?.email || "",
    address: completeAddress(customer?.address),
    country_of_origin: customer?.country_of_origin || "",
    next_of_kin: customer?.next_of_kin || "",
    next_of_kin_phone: customer?.next_of_kin_phone || "",
    licence_type: customer?.licence_type || "",
    licence_photo_front_url: frontLicenceUrl,
    licence_photo_back_url: backLicenceUrl,
    license_photo_front_url: frontLicenceUrl,
    license_photo_back_url: backLicenceUrl,
    status: "PENDING",
    payment_status: "PENDING",
    created_at: now,
    updated_at: now,
  });
}

async function loadState(platform, platformId) {
  const [booking, customer] = await Promise.all([
    findActiveBooking(platform, platformId),
    findCustomer(platform, platformId),
  ]);

  return {
    booking,
    customer,
    state: toState(booking, customer),
  };
}

async function resetActiveBooking(platform, platformId) {
  const booking = await findActiveBooking(platform, platformId);
  if (!booking) return false;

  booking.status = "CANCELLED";
  booking.notes = [booking.notes, "Reset by customer conversation command"]
    .filter(Boolean)
    .join("\n");
  booking.updated_at = new Date().toISOString();
  await booking.save();
  return true;
}

async function saveField(platform, platformId, field, rawValue) {
  if (!Object.prototype.hasOwnProperty.call(FIELD_TO_BOOKING_FIELD, field)) {
    return { ok: false, reason: `Unknown booking field ${field}` };
  }

  const value = sanitizeValue(field, rawValue);
  if (!value) {
    if (field === "address") {
      return {
        ok: false,
        reason:
          "Please send the full Sunshine Coast address, including the house or unit number.",
      };
    }
    return { ok: false, reason: `Invalid value for ${field}` };
  }

  const customer = await ensureCustomer(platform, platformId);
  const booking = await ensureBooking(platform, platformId, customer);
  const now = new Date().toISOString();
  const bookingField = FIELD_TO_BOOKING_FIELD[field];

  booking[bookingField] = value;
  for (const alias of FIELD_ALIASES[field] || []) {
    booking[alias] = value;
  }
  if (field === "address" && booking.pickup_delivery === "delivery") {
    booking.delivery_address = value;
  }
  booking.updated_at = now;
  await booking.save();

  const customerField = CUSTOMER_FIELDS[field];
  if (customerField) {
    customer[customerField] = value;
    for (const alias of FIELD_ALIASES[field] || []) {
      customer[alias] = value;
    }
    if (field === "name") customer.full_name = value;
    customer.updated_at = now;
    customer.last_contact = now;
    await customer.save();
  }

  return { ok: true, field, value, booking };
}

async function saveLicencePhoto(platform, platformId, mediaUrl) {
  const { state } = await loadState(platform, platformId);

  if (!mediaUrl) {
    return { ok: false, reason: "No licence photo was attached" };
  }

  if (!/^https?:\/\//i.test(String(mediaUrl))) {
    return {
      ok: false,
      reason:
        "The licence photo could not be uploaded. Please check Cloudinary is configured, then send the photo again.",
    };
  }

  if (!state.licencePhotoFrontReceived) {
    return saveField(platform, platformId, "licencePhotoFrontUrl", mediaUrl);
  }

  if (!state.licencePhotoBackReceived) {
    return saveField(platform, platformId, "licencePhotoBackUrl", mediaUrl);
  }

  return { ok: true, field: "licencePhotoExtra", value: "already_received" };
}

function calculatePricing(scooterType, pickupOrDelivery) {
  return pricingService.quote(scooterType, pickupOrDelivery);
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function datesOverlap(startA, endA, startB, endB) {
  const aStart = new Date(startA);
  const aEnd = new Date(endA);
  const bStart = new Date(startB);
  const bEnd = new Date(endB);

  if (
    [aStart, aEnd, bStart, bEnd].some((date) => Number.isNaN(date.getTime()))
  ) {
    return true; // treat invalid dates as conflicting — safe default
  }

  // Add 1-day buffer after each booking ends before next can start
  // e.g. Booking A ends May 15 → next booking cannot start until May 17
  const BUFFER_DAYS = 1;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const aEndWithBuffer = new Date(aEnd.getTime() + BUFFER_DAYS * MS_PER_DAY);
  const bEndWithBuffer = new Date(bEnd.getTime() + BUFFER_DAYS * MS_PER_DAY);

  return aStart < bEndWithBuffer && bStart < aEndWithBuffer;
}

function activeHoldHasNotExpired(booking, now = new Date()) {
  if (booking.status !== "HELD_AWAITING_PAYMENT") return false;
  if (!booking.hold_expires_at) return true;

  const expiresAt = new Date(booking.hold_expires_at);
  return Number.isNaN(expiresAt.getTime()) || expiresAt > now;
}

function bookingBlocksDates(booking, now = new Date()) {
  if (booking.status === "CONFIRMED") return true;
  return activeHoldHasNotExpired(booking, now);
}

async function releaseExpiredHoldIfNeeded(scooter, now = new Date()) {
  if (scooter.status !== "HELD" || !scooter.hold_expires_at) return scooter;

  const expiresAt = new Date(scooter.hold_expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt > now) return scooter;

  scooter.markAvailable();
  await scooter.save();
  return scooter;
}

async function scooterHasDateConflict(
  scooterPlate,
  startDate,
  endDate,
  currentBookingId,
) {
  const candidates = await Booking.find({
    scooter_plate: scooterPlate,
    booking_id: { $ne: currentBookingId },
    status: { $in: ["HELD_AWAITING_PAYMENT", "CONFIRMED"] },
    payment_status: { $ne: "EXPIRED" },
    start_date: { $exists: true, $nin: [null, ""] },
    end_date: { $exists: true, $nin: [null, ""] },
  }).lean();

  const now = new Date();
  return candidates.some(
    (booking) =>
      bookingBlocksDates(booking, now) &&
      datesOverlap(startDate, endDate, booking.start_date, booking.end_date),
  );
}

async function assignScooterHold(booking, state, holdExpiresAt) {
  if (booking.scooter_plate) {
    const scooter = await Fleet.findOne({
      scooter_plate: booking.scooter_plate,
    });

    if (!scooter || ["MAINTENANCE", "RETIRED"].includes(scooter.status)) {
      booking.scooter_plate = "";
    } else {
      const hasConflict = await scooterHasDateConflict(
        booking.scooter_plate,
        state.startDate,
        state.endDate,
        booking.booking_id,
      );

      if (!hasConflict) {
        return { ok: true, scooterPlate: booking.scooter_plate };
      }

      booking.scooter_plate = "";
    }
  }

  const scooters = await Fleet.find({
    scooter_type: state.scooterType,
    status: { $nin: ["MAINTENANCE", "RETIRED"] },
  }).sort({ scooter_plate: 1 });

  for (const scooter of scooters) {
    await releaseExpiredHoldIfNeeded(scooter);

    if (scooter.status === "MAINTENANCE" || scooter.status === "RETIRED") {
      continue;
    }

    const hasConflict = await scooterHasDateConflict(
      scooter.scooter_plate,
      state.startDate,
      state.endDate,
      booking.booking_id,
    );

    if (hasConflict) continue;

    booking.scooter_plate = scooter.scooter_plate;
    return { ok: true, scooterPlate: scooter.scooter_plate };
  }

  return {
    ok: false,
    reason: `No ${state.scooterType} scooter is available for ${state.startDate} to ${state.endDate}.`,
  };
}

function missingBeforePayment(state) {
  const required = [
    ["scooterType", "scooter type"],
    ["licenceType", "licence type"],
    ["startDate", "start date"],
    ["endDate", "end date"],
    ["pickupOrDelivery", "pickup/delivery option"],
    ["countryOfOrigin", "country"],
    ["address", "address"],
    ["name", "name"],
    ["phone", "mobile number"],
    ["email", "email"],
    ["nextOfKin", "emergency contact"],
    ["nextOfKinPhone", "emergency contact mobile"],
    ["licencePhotoFrontUrl", "front licence photo"],
    ["licencePhotoBackUrl", "back licence photo"],
  ];

  return required.filter(([field]) => !state[field]).map(([, label]) => label);
}

async function finalizeBookingIfReady(platform, platformId) {
  const { booking, customer, state } = await loadState(platform, platformId);
  const missing = missingBeforePayment(state);

  if (missing.length) {
    return { ok: false, ready: false, missing };
  }

  if (!booking) {
    return { ok: false, ready: false, missing: ["booking record"] };
  }

  // Already paid — do NOT resend payment link
  if (booking.payment_status === "PAID" || booking.status === "CONFIRMED") {
    return {
      ok: true,
      ready: true,
      alreadyPaid: true,
      booking,
      paymentLink: null,
      amountUpfront: booking.amount_upfront,
    };
  }

  // Payment link already created but not paid yet — resend same link
  if (booking.stripe_link) {
    const now = new Date().toISOString();

    if (
      booking.status === "HELD_AWAITING_PAYMENT" &&
      !booking.hold_expires_at
    ) {
      booking.hold_expires_at = addHours(
        new Date(),
        HOLD_DURATION_HOURS,
      ).toISOString();
      booking.reminder_1_sent = booking.reminder_1_sent || "";
      booking.reminder_2_sent = booking.reminder_2_sent || "";
      booking.reminder_3_sent = booking.reminder_3_sent || "";
      booking.updated_at = now;
      await booking.save();
    }

    return {
      ok: true,
      ready: true,
      alreadyFinalized: true,
      booking,
      paymentLink: booking.stripe_link,
      amountUpfront: booking.amount_upfront,
    };
  }

  const now = new Date().toISOString();
  const holdExpiresAt = addHours(new Date(), HOLD_DURATION_HOURS).toISOString();

  // Enforce minimum 1 week hire
  if (state.startDate && state.endDate) {
    const start = new Date(state.startDate);
    const end = new Date(state.endDate);
    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    // If less than 7 days — still proceed but charge for 1 full week
    if (days < 7) {
      const minEnd = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      state.endDate = minEnd.toISOString().split("T")[0];
      // Update booking end date to minimum 1 week
      await Booking.findOneAndUpdate(
        { booking_id: state.bookingId },
        {
          $set: {
            end_date: state.endDate,
            updated_at: new Date().toISOString(),
          },
        },
      );
      console.log(
        `⚠️ Hire less than 1 week — extended to ${state.endDate} (minimum charge applies)`,
      );
    }
  }

  const scooterHold = await assignScooterHold(booking, state, holdExpiresAt);

  if (!scooterHold.ok) {
    booking.status = "PENDING";
    booking.updated_at = now;
    booking.notes = [booking.notes, scooterHold.reason]
      .filter(Boolean)
      .join("\n");
    await booking.save();

    return {
      ok: false,
      ready: true,
      noAvailability: true,
      booking,
      reason: scooterHold.reason,
    };
  }

  const pricing = calculatePricing(state.scooterType, state.pickupOrDelivery);

  booking.first_week_rate = pricing.firstWeekRate;
  booking.weekly_rate = pricing.weeklyRate;
  booking.deposit = pricing.deposit;
  booking.delivery_fee = pricing.deliveryFee;
  booking.amount_upfront = pricing.amountUpfront;
  booking.status = "HELD_AWAITING_PAYMENT";
  booking.payment_status = "PENDING";
  booking.hold_expires_at = holdExpiresAt;
  booking.reminder_1_sent = "";
  booking.reminder_2_sent = "";
  booking.reminder_3_sent = "";
  booking.updated_at = now;
  await booking.save();

  if (customer) {
    customer.customer_status = "IN_PROGRESS";
    customer.updated_at = now;
    customer.last_contact = now;
    await customer.save();
  }

  console.log("💳 Creating upfront payment link:", {
    bookingId: booking.booking_id,
    amountUpfront: pricing.amountUpfront,
    weeklyRate: pricing.weeklyRate,
    deposit: pricing.deposit,
    deliveryFee: pricing.deliveryFee,
  });

  const stripeResult = await stripeService.createUpfrontPaymentLink(booking);
  if (!stripeResult?.url) {
    return {
      ok: false,
      ready: true,
      booking,
      reason:
        "Stripe payment link could not be created. Check STRIPE_SECRET_KEY and Stripe logs.",
    };
  }

  booking.stripe_link = stripeResult.url;
  booking.stripe_session_id = stripeResult.sessionId;

  return {
    ok: true,
    ready: true,
    booking,
    paymentLink: stripeResult.url,
    amountUpfront: pricing.amountUpfront,
    pricing,
  };
}

async function applyToolCalls(platform, platformId, toolCalls = []) {
  const saved = [];
  const rejected = [];

  for (const toolCall of toolCalls) {
    const parsed = parseToolCall(toolCall);
    if (!parsed) continue;

    const result = await saveField(
      platform,
      platformId,
      parsed.field,
      parsed.value,
    );
    if (result.ok) saved.push({ field: result.field, value: result.value });
    else rejected.push(result.reason);
  }

  return { saved, rejected };
}

async function applyExpectedFieldFallback(platform, platformId, text) {
  const { state } = await loadState(platform, platformId);
  const expected = nextField(state);
  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (!t) return null;

  if (expected === "scooterType") {
    if (/\b125\s*cc\b|\b125\b/i.test(t)) {
      return saveField(platform, platformId, "scooterType", "125cc");
    }
    if (/\b50\s*cc\b|\b50\b/i.test(t) && !/\b500\s*cc\b|\b500\b/i.test(t)) {
      return saveField(platform, platformId, "scooterType", "50cc");
    }
    if (/\b\d+\s*cc\b/i.test(t)) {
      return {
        ok: false,
        reason:
          "Sorry, we only hire 50cc and 125cc scooters. Which one would you like?",
      };
    }
  }

  if (expected === "dates") {
    const parsedDates = parseDateInput(t);
    if (parsedDates) {
      const start = await saveField(
        platform,
        platformId,
        "startDate",
        parsedDates.startDate,
      );
      const end = await saveField(
        platform,
        platformId,
        "endDate",
        parsedDates.endDate,
      );
      return {
        ok: start.ok && end.ok,
        field: "dates",
        value: `${parsedDates.startDate} to ${parsedDates.endDate}`,
        reason: start.reason || end.reason,
      };
    }
  }

  if (expected === "phone" || expected === "nextOfKinPhone") {
    const compact = t.replace(/[^\d+]/g, "");
    if (
      /^04\d{8}$/.test(compact) ||
      /^614\d{8}$/.test(compact) ||
      /^\+614\d{8}$/.test(compact)
    ) {
      return saveField(platform, platformId, expected, compact);
    }
    if (compact.length >= 8) {
      return {
        ok: false,
        reason: "Please send an Australian mobile number, like 0412345678.",
      };
    }
  }

  if (expected === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
    return saveField(platform, platformId, "email", t);
  }

  if (
    expected === "pickupOrDelivery" &&
    /deliver|pickup|pick up|collect/i.test(t)
  ) {
    return saveField(platform, platformId, "pickupOrDelivery", t);
  }

  if (expected === "licenceType") {
    if (/motor|car|licen|driver/i.test(t)) {
      return saveField(platform, platformId, "licenceType", t);
    }
    if (
      /^(yes|yeah|yep|i have|yes i have|sure)$/i.test(t) &&
      state.scooterType === "50cc"
    ) {
      return saveField(platform, platformId, "licenceType", "car");
    }
    if (
      /^(yes|yeah|yep|i have|yes i have|sure)$/i.test(t) &&
      state.scooterType === "125cc"
    ) {
      return saveField(platform, platformId, "licenceType", "motorcycle");
    }
  }

  if (
    expected === "countryOfOrigin" &&
    /^[a-zA-Z\s'-]{2,}$/.test(t) &&
    !["delivery", "pickup", "yes", "no", "ok"].includes(lower)
  ) {
    return saveField(platform, platformId, "countryOfOrigin", t);
  }

  const nonNames = [
    "what",
    "ok",
    "okay",
    "next",
    "so next what",
    "yes",
    "no",
    "nah",
    "yeah",
  ];
  if (
    (expected === "name" || expected === "nextOfKin") &&
    /^[a-zA-Z\s'-]{2,}$/.test(t) &&
    !nonNames.includes(lower)
  ) {
    return saveField(platform, platformId, expected, t);
  }

  if (expected === "address" && t.length >= 8 && /\d/.test(t)) {
    return saveField(platform, platformId, "address", t);
  }

  return null;
}

async function inferFromAssistantReply(platform, platformId, replyText) {
  const { state } = await loadState(platform, platformId);
  const text = String(replyText || "").toLowerCase();

  if (!state.scooterType) {
    if (
      /\b50cc\b/.test(text) &&
      /(ideal|perfect|recommend|would be good|would suit)/i.test(text)
    ) {
      return saveField(platform, platformId, "scooterType", "50cc");
    }
    if (
      /\b125cc\b/.test(text) &&
      /(ideal|perfect|recommend|would be good|would suit|you'?d want)/i.test(
        text,
      )
    ) {
      return saveField(platform, platformId, "scooterType", "125cc");
    }
  }

  return null;
}

module.exports = {
  loadState,
  resetActiveBooking,
  buildBookingContext,
  buildNextQuestion,
  saveLicencePhoto,
  finalizeBookingIfReady,
  applyToolCalls,
  applyExpectedFieldFallback,
  inferFromAssistantReply,
  saveField,
  nextField,
  prefillFromCustomerProfile,
};
