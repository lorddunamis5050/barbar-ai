import { prisma } from "@/lib/prisma";
import { MessageRole, Channel, ConversationStatus, BookingStatus, Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { NextResponse } from "next/server";
import {
  BUFFER_MIN,
  parseStart,
  minutesForService,
  isWithinBusinessHours,
  enforceSameDayLead,
  getTz,
  SERVICES,
} from "@/lib/bookingRules";

type Draft = {
  serviceName?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM (24h)
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  notes?: string;
  confirmed?: boolean;
};

const SERVICE_NAMES = Object.keys(SERVICES);

function extractDraft(message: string, prev: Draft): Draft {
  const text = message.trim();
  const lower = text.toLowerCase();
  const next: Draft = { ...prev };

  // service matching (simple)
  if (!next.serviceName) {
    for (const s of SERVICE_NAMES) {
      if (lower.includes(s.toLowerCase().split(" ")[0])) {
        // rough but works; can be improved
        next.serviceName = s;
        break;
      }
    }
    if (lower.includes("haircut")) next.serviceName = "Haircut (Standard)";
    if (lower.includes("beard")) next.serviceName = "Beard Trim";
    if (lower.includes("wash")) next.serviceName = "Wash & Style";
    if (lower.includes("buzz")) next.serviceName = "Buzz Cut";
    if (lower.includes("kids")) next.serviceName = "Kids Haircut";
    if (lower.includes("shave")) next.serviceName = "Head Shave";
  }

  const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (dateMatch) next.date = dateMatch[1];

  const timeMatch = text.match(/\b([01]\d|2[0-3]):([0-5]\d)\b/);
  if (timeMatch) next.time = `${timeMatch[1]}:${timeMatch[2]}`;

  const phoneMatch = text.match(/(\+?\d[\d\s().-]{8,}\d)/);
  if (phoneMatch && !next.customerPhone) next.customerPhone = phoneMatch[1].trim();

  const nameMatch = text.match(/my name is\s+([a-zA-Z][a-zA-Z\s'-]{1,50})/i);
  if (nameMatch && !next.customerName) next.customerName = nameMatch[1].trim();

  const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (emailMatch && !next.customerEmail) next.customerEmail = emailMatch[0];

  if (/\b(confirm|book it|yes|sounds good)\b/i.test(lower)) next.confirmed = true;
  if (/\b(cancel|never mind|stop)\b/i.test(lower)) next.confirmed = false;

  return next;
}

function missingFields(d: Draft): (keyof Draft)[] {
  const req: (keyof Draft)[] = ["serviceName", "date", "time", "customerName", "customerPhone"];
  return req.filter((k) => !d[k]);
}

function nextQuestion(missing: (keyof Draft)[]) {
  switch (missing[0]) {
    case "serviceName":
      return `What service would you like? Choose one: ${SERVICE_NAMES.join(", ")}`;
    case "date":
      return "What date would you like? Use YYYY-MM-DD.";
    case "time":
      return "What time would you like? Use 24h HH:MM (example 14:30).";
    case "customerName":
      return "What’s your full name?";
    case "customerPhone":
      return "What phone number should we use to confirm your appointment?";
    default:
      return "What would you like to book?";
  }
}

function summary(d: Draft) {
  return `Booking summary:\n- Service: ${d.serviceName}\n- Date: ${d.date}\n- Time: ${d.time}\n- Name: ${d.customerName}\n- Phone: ${d.customerPhone}\n\nReply “confirm” to book, or tell me what to change.`;
}

async function validateAndSave(draft: Draft) {
  const tz = getTz();
  const now = DateTime.now().setZone(tz);

  if (!draft.serviceName || !draft.date || !draft.time || !draft.customerName || !draft.customerPhone) {
    return { ok: false as const, reason: "Missing required booking info." };
  }

  const mins = minutesForService(draft.serviceName);
  if (!mins) return { ok: false as const, reason: "That service is not supported." };

  const start = parseStart(draft.date, draft.time);
  if (!start) return { ok: false as const, reason: "Invalid date/time format." };

  const end = start.plus({ minutes: mins + BUFFER_MIN });

  if (start <= now) return { ok: false as const, reason: "That time is in the past. Pick a future time." };

  const lead = enforceSameDayLead(start, now);
  if (!lead.ok) return lead;

  const hoursOk = isWithinBusinessHours(start, end);
  if (!hoursOk.ok) return hoursOk;

  // conflict check
  const overlap = await prisma.booking.findFirst({
    where: {
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      startAt: { lt: end.toJSDate() },
      endAt: { gt: start.toJSDate() },
    },
  });

  if (overlap) {
    return { ok: false as const, reason: "That time is already taken. Please choose another time." };
  }

  const booking = await prisma.booking.create({
    data: {
      status: BookingStatus.CONFIRMED,
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      customerEmail: draft.customerEmail ?? null,
      serviceName: draft.serviceName,
      startAt: start.toJSDate(),
      endAt: end.toJSDate(),
      notes: draft.notes ?? null,
    },
  });

  return { ok: true as const, bookingId: booking.id };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.message !== "string") {
    return NextResponse.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  const conversation =
    body.conversationId
      ? await prisma.conversation.findUnique({ where: { id: body.conversationId } })
      : await prisma.conversation.create({ data: { channel: Channel.CHAT, status: ConversationStatus.OPEN } });

  if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });

  await prisma.message.create({
    data: { conversationId: conversation.id, role: MessageRole.USER, content: body.message },
  });

  const prevDraft = (conversation.bookingDraft ?? {}) as Draft;
  const draft = extractDraft(body.message, prevDraft);

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { bookingDraft: draft as any },
  });

  const missing = missingFields(draft);

  let reply = "";

  if (missing.length > 0) {
    reply = nextQuestion(missing);
  } else {
    // All fields collected
    if (draft.confirmed) {
      const result = await validateAndSave(draft);

      if (!result.ok) {
        // confirmation attempted but invalid → force correction loop
        reply = `Can't book that yet: ${result.reason}\n\nTell me a new date/time (YYYY-MM-DD HH:MM).`;
        // wipe only time/date so they must re-enter
        const updatedDraft: Draft = { ...draft, date: undefined, time: undefined, confirmed: false };
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { bookingDraft: updatedDraft as any },
        });
      } else {
        reply = `✅ Booked! Your appointment is confirmed.\n\n- Service: ${draft.serviceName}\n- Date: ${draft.date}\n- Time: ${draft.time}\n\nBooking ID: ${result.bookingId}`;
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { status: ConversationStatus.CLOSED, bookingDraft: Prisma.DbNull },
        });
      }
    } else {
      reply = summary(draft);
    }
  }

  await prisma.message.create({
    data: { conversationId: conversation.id, role: MessageRole.AGENT, content: reply },
  });

  return NextResponse.json({ conversationId: conversation.id, reply, draft });
}
