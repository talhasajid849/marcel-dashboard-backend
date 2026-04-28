function ODOMETER_CHECK_PROMPT(name = 'there', scooterPlate = 'your scooter') {
  return `Hey ${name}, it is Marcel from Honk Hire Co. Can you send through the current odometer reading for ${scooterPlate}? Just the number on the dash is perfect.`;
}

function ODOMETER_FOLLOWUP_MESSAGE(name = 'there') {
  return `Hey ${name}, just following up on the odometer reading when you get a chance. It helps us keep servicing on schedule.`;
}

module.exports = {
  ODOMETER_CHECK_PROMPT,
  ODOMETER_FOLLOWUP_MESSAGE,
};
