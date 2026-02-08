import nodemailer from "nodemailer";

type BookingEmail = {
  to: string;
  name: string;
  service: string;
  dateLabel: string;
  timeLabel: string;
  bookingId: string;
};

const SMTP_HOST = process.env.SMTP_HOST || "smtp.hostinger.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === "true"
  : SMTP_PORT === 465;
const SMTP_DEBUG = process.env.SMTP_DEBUG === "true";

export async function sendBookingConfirmationEmail(details: BookingEmail) {
  if (!SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    throw new Error("SMTP credentials are not configured");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    logger: SMTP_DEBUG,
    debug: SMTP_DEBUG,
  });

  if (SMTP_DEBUG) {
    await transporter.verify();
  }

  const subject = `Booking confirmed: ${details.service}`;
  const text = `Hi ${details.name},\n\nYou’re all set ✂️\n${details.service}\n${details.dateLabel} at ${details.timeLabel}\n\nBooking ID: ${details.bookingId}\n\nNeed to reschedule? Just reply to this email.`;

  await transporter.sendMail({
    from: SMTP_FROM,
    to: details.to,
    subject,
    text,
  });
}