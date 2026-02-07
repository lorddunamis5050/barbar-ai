import { prisma } from "@/lib/prisma";
import { MessageRole, Channel, ConversationStatus, BookingStatus, Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { NextResponse } from "next/server";
import { extractBookingInfo } from "@/lib/ai";
import {
  BUFFER_MIN,
  parseStart,
  minutesForService,
  isWithinBusinessHours,
  enforceSameDayLead,
  getTz,
  SERVICES,
  HOURS,
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

function formatServiceList() {
  return SERVICE_NAMES.map((name) => `${name} — ${SERVICES[name]} min`).join(", ");
}

function formatHours() {
  const entries = Object.entries(HOURS);
  return entries
    .map(([day, hours]) => {
      if (!hours) return `${day}: Closed`;
      return `${day}: ${hours.open}-${hours.close}`;
    })
    .join(", ");
}

function missingFields(d: Draft): (keyof Draft)[] {
  const req: (keyof Draft)[] = ["serviceName", "date", "time", "customerName", "customerPhone"];
  return req.filter((k) => !d[k]);
}

function nextQuestion(missing: (keyof Draft)[]) {
  switch (missing[0]) {
    case "serviceName":
      return `Which service would you like? We offer: ${SERVICE_NAMES.join(", ")}.`;
    case "date":
      return "What day works best for you? (You can say 'next Monday' or 'Feb 12')";
    case "time":
      return "What time works best? (e.g., 10am or 14:30)";
    case "customerName":
      return "May I have your full name?";
    case "customerPhone":
      return "What’s the best phone number to confirm your appointment?";
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
  try {
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

    const lower = body.message.toLowerCase();
    const asksServices = /\b(service|services|menu|options|offer)\b/.test(lower);
    const asksServiceDuration = /\b(duration|service time|how long)\b/.test(lower);
    const asksHours = /\b(hours|open|opening|close|closing|business hours)\b/.test(lower);

    if (asksServices || asksServiceDuration || asksHours) {
      const parts: string[] = [];
      if (asksServices || asksServiceDuration) {
        parts.push(`Services and durations: ${formatServiceList()}.`);
      }
      if (asksHours) {
        parts.push(`Business hours (${getTz()}): ${formatHours()}.`);
      }

      const reply = parts.join(" ").trim();

      await prisma.message.create({
        data: { conversationId: conversation.id, role: MessageRole.AGENT, content: reply },
      });

      return NextResponse.json({ conversationId: conversation.id, reply, draft: conversation.bookingDraft ?? {} });
    }

    const prevDraft = (conversation.bookingDraft ?? {}) as Draft;
    const draft = await extractBookingInfo(body.message, prevDraft);

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
          // confirmation attempted but invalid → guide user naturally
          let updatedDraft: Draft = { ...draft, confirmed: false };
          if (/opens at/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, time: undefined };
            reply = `${result.reason} What time works for you on ${draft.date}?`;
          } else if (/closes at/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, time: undefined };
            reply = `${result.reason} What time works for you on ${draft.date}?`;
          } else if (/closed that day/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, date: undefined, time: undefined };
            reply = `${result.reason} What day would you like instead?`;
          } else if (/already taken/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, time: undefined };
            reply = `${result.reason} What time would you like instead?`;
          } else if (/past/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, date: undefined, time: undefined };
            reply = `That time has already passed. What day and time work for you?`;
          } else {
            updatedDraft = { ...updatedDraft, date: undefined, time: undefined };
            reply = `I couldn't book that yet: ${result.reason} What day and time work for you?`;
          }
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Chat API error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
