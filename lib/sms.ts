import twilio from "twilio";

type BookingSms = {
  to: string;
  name: string;
  service: string;
  dateLabel: string;
  timeLabel: string;
};

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;

export async function sendBookingConfirmationSms(details: BookingSms) {
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    throw new Error("Twilio credentials are not configured");
  }

  if (!FROM_NUMBER && !MESSAGING_SERVICE_SID) {
    throw new Error("Twilio sender is not configured");
  }

  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  const body = `Period 🤏🏾 — You’re all set ✂️\n${details.service}\n${details.dateLabel} at ${details.timeLabel}\nNeed to reschedule? Just text us.`;

  await client.messages.create({
    to: details.to,
    from: FROM_NUMBER,
    messagingServiceSid: MESSAGING_SERVICE_SID,
    body,
  });
}