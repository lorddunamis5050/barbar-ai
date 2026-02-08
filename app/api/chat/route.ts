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
import { sendBookingConfirmationEmail } from "@/lib/email";
import { sendBookingConfirmationSms } from "@/lib/sms";

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

const SERVICE_ALIASES: Record<string, string> = {
  haircut: "Haircut (Standard)",
  haircuts: "Haircut (Standard)",
  "standard haircut": "Haircut (Standard)",
  "haircut standard": "Haircut (Standard)",
  "beard trim": "Beard Trim",
  beard: "Beard Trim",
  "wash & style": "Wash & Style",
  wash: "Wash & Style",
  style: "Wash & Style",
  "head shave": "Head Shave",
  shave: "Head Shave",
  "kids haircut": "Kids Haircut",
  kids: "Kids Haircut",
  "buzz cut": "Buzz Cut",
  buzz: "Buzz Cut",
};

function normalizeServiceName(name?: string) {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (SERVICES[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  if (SERVICE_ALIASES[lower]) return SERVICE_ALIASES[lower];
  for (const key of Object.keys(SERVICE_ALIASES)) {
    if (lower.includes(key)) return SERVICE_ALIASES[key];
  }
  return name;
}

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
  const req: (keyof Draft)[] = [
    "serviceName",
    "date",
    "time",
    "customerName",
    "customerPhone",
    "customerEmail",
  ];
  return req.filter((k) => !d[k]);
}

function nextQuestion(missing: (keyof Draft)[]) {
  switch (missing[0]) {
    case "serviceName":
      return `Which service would you like? We offer: ${SERVICE_NAMES.join(", ")}.`;
    case "date":
      return "What day works best for you? (e.g., next Monday)";
    case "time":
      return "What time works best? (e.g., 10am or 14:30)";
    case "customerName":
      return "May I have your first and last name?";
    case "customerPhone":
      return "What’s the best phone number to confirm your appointment?";
    case "customerEmail":
      return "What email should we use for the confirmation?";
    default:
      return "What would you like to book?";
  }
}

function summary(d: Draft) {
  const dateLabel = d.date ? DateTime.fromISO(d.date).toFormat("cccc, LLL d") : "";
  const timeLabel = d.time
    ? DateTime.fromFormat(d.time, "HH:mm").toFormat("h:mm a")
    : "";
  return `Here’s what I’ve got ✨\n${d.serviceName}\n${dateLabel}${timeLabel ? ` — ${timeLabel}` : ""}\n\nBooking for ${d.customerName}\nPhone: ${d.customerPhone}\nEmail: ${d.customerEmail}\n\nType “confirm” to lock it in, or tell me what to change.`;
}

function formatDateLabel(date?: string) {
  if (!date) return "";
  const dt = DateTime.fromISO(date);
  if (!dt.isValid) return date;
  return dt.toFormat("cccc, LLL d");
}

function formatTimeLabel(time?: string) {
  if (!time) return "";
  const dt = DateTime.fromFormat(time, "HH:mm");
  if (!dt.isValid) return time;
  return dt.toFormat("h:mm a");
}

function isVagueTime(message: string) {
  return /\b(morning|afternoon|evening|tonight|later)\b/i.test(message);
}

async function suggestTimes(date: string, serviceName?: string, durationOverride?: number) {
  const mins = durationOverride ?? (serviceName ? minutesForService(serviceName) : null);
  if (!mins) return [] as string[];

  const tz = getTz();
  const day = DateTime.fromISO(date, { zone: tz });
  if (!day.isValid) return [] as string[];

  const dayKey = day.toFormat("cccc").toLowerCase();
  const hours = HOURS[dayKey];
  if (!hours) return [] as string[];

  const open = DateTime.fromISO(`${date}T${hours.open}`, { zone: tz });
  const close = DateTime.fromISO(`${date}T${hours.close}`, { zone: tz });
  const now = DateTime.now().setZone(tz);

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      startAt: { lt: close.toJSDate() },
      endAt: { gt: open.toJSDate() },
    },
    select: { startAt: true, endAt: true },
  });

  const stepMinutes = 30;
  const suggestions: string[] = [];

  for (let t = open; t.plus({ minutes: mins + BUFFER_MIN }) <= close; t = t.plus({ minutes: stepMinutes })) {
    if (!enforceSameDayLead(t, now).ok) continue;
    const end = t.plus({ minutes: mins + BUFFER_MIN });

    const overlaps = bookings.some((b) => {
      return t.toJSDate() < b.endAt && end.toJSDate() > b.startAt;
    });
    if (overlaps) continue;

    suggestions.push(t.toFormat("h:mm a"));
    if (suggestions.length >= 5) break;
  }

  return suggestions;
}

type AvailabilityResult = {
  ok: boolean;
  reason?: string;
  alternatives?: string[];
};

async function checkAvailability(draft: Draft): Promise<AvailabilityResult> {
  if (!draft.date || !draft.time) {
    return { ok: false, reason: "missing-date-time" };
  }

  const duration = draft.serviceName ? minutesForService(draft.serviceName) : 30;
  if (!duration) return { ok: false, reason: "unsupported-service" };

  const start = parseStart(draft.date, draft.time);
  if (!start) return { ok: false, reason: "invalid-date-time" };

  const end = start.plus({ minutes: duration + BUFFER_MIN });
  const now = DateTime.now().setZone(getTz());

  if (start <= now) return { ok: false, reason: "past" };

  const lead = enforceSameDayLead(start, now);
  if (!lead.ok) return { ok: false, reason: lead.reason };

  const hoursOk = isWithinBusinessHours(start, end);
  if (!hoursOk.ok) return { ok: false, reason: hoursOk.reason };

  const overlap = await prisma.booking.findFirst({
    where: {
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      startAt: { lt: end.toJSDate() },
      endAt: { gt: start.toJSDate() },
    },
  });

  if (overlap) {
    const alternatives = await suggestTimes(draft.date, draft.serviceName, duration);
    return { ok: false, reason: "taken", alternatives };
  }

  return { ok: true };
}

async function validateAndSave(draft: Draft) {
  const tz = getTz();
  const now = DateTime.now().setZone(tz);

  if (
    !draft.serviceName ||
    !draft.date ||
    !draft.time ||
    !draft.customerName ||
    !draft.customerPhone ||
    !draft.customerEmail
  ) {
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
    const asksHours =
      /\b(hours|open|opening|close|closing|business hours)\b/.test(lower) ||
      /\bbusi\w{0,6}\s+hou\w*/i.test(lower) ||
      /\bhou\w*\s+of\s+operation\b/i.test(lower);
    const asksAvailability = /\b(are you free|are you available|availability|any openings|openings|free at|available at)\b/i.test(
      lower
    );
    const trimmed = lower.trim();
    const isGreetingOnly = /^(hi|hello|hey|yo|good\s+morning|good\s+afternoon|good\s+evening)\b/i.test(trimmed)
      && trimmed.split(/\s+/).length <= 3
      && !/\b(book|appointment|schedule|haircut|beard|shave|wash|buzz|kids|trim|style|next|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(trimmed);

    if (isGreetingOnly) {
      const reply = "Hey! What service would you like?";

      await prisma.message.create({
        data: { conversationId: conversation.id, role: MessageRole.AGENT, content: reply },
      });

      return NextResponse.json({ conversationId: conversation.id, reply, draft: conversation.bookingDraft ?? {} });
    }

    if (asksServices || asksServiceDuration || asksHours) {
      const parts: string[] = [];
      if (asksServices || asksServiceDuration) {
        parts.push(`Here are our services and durations: ${formatServiceList()}.`);
      }
      if (asksHours) {
        parts.push(`We’re open (${getTz()}): ${formatHours()}.`);
      }
      parts.push("What would you like to book?");
      const reply = parts.join(" ").trim();

      await prisma.message.create({
        data: { conversationId: conversation.id, role: MessageRole.AGENT, content: reply },
      });

      return NextResponse.json({ conversationId: conversation.id, reply, draft: conversation.bookingDraft ?? {} });
    }

    const prevDraft = (conversation.bookingDraft ?? {}) as Draft;
    const draft = await extractBookingInfo(body.message, prevDraft);
    draft.serviceName = normalizeServiceName(draft.serviceName);

    if (asksAvailability) {
      const availability = await checkAvailability(draft);
      let reply = "";

      if (availability.ok) {
        const dateLabel = formatDateLabel(draft.date);
        const timeLabel = formatTimeLabel(draft.time);
        reply = `Yes — ${dateLabel} at ${timeLabel} is available. What service would you like?`;
      } else if (availability.reason === "missing-date-time") {
        reply = "Sure — what day and time are you thinking?";
      } else if (availability.reason === "invalid-date-time") {
        reply = "I can check that — what day and time should I look for?";
      } else if (availability.reason === "past") {
        reply = "That time has already passed. What day and time work for you?";
      } else if (availability.reason === "taken") {
        const options = availability.alternatives ?? [];
        const optionText = options.length ? ` A few options: ${options.join(", ")}.` : "";
        reply = `That time is taken.${optionText} What time works for you?`;
      } else if (typeof availability.reason === "string") {
        if (/opens at|closes at|closed that day/i.test(availability.reason)) {
          reply = `We’re not open then — ${availability.reason} What time works instead?`;
        } else {
          reply = `I can’t book that time yet. What day and time work for you?`;
        }
      }

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { bookingDraft: draft as any },
      });

      await prisma.message.create({
        data: { conversationId: conversation.id, role: MessageRole.AGENT, content: reply },
      });

      return NextResponse.json({ conversationId: conversation.id, reply, draft });
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { bookingDraft: draft as any },
    });

    const missing = missingFields(draft);

    let reply = "";

    if (missing.length > 0) {
      if (missing.includes("serviceName")) {
        reply = nextQuestion(["serviceName"]);
      } else if (missing.includes("date") && missing.includes("time")) {
        const serviceLabel = draft.serviceName ? `Perfect — ${draft.serviceName}. ` : "";
        reply = `${serviceLabel}What day and time work best for you? (e.g., next Monday at 10am)`;
      } else if (missing.includes("date")) {
        const timeLabel = draft.time ? ` at ${formatTimeLabel(draft.time)}` : "";
        reply = `Got it${timeLabel}. What day works best for you?`;
      } else if (missing.includes("time")) {
        const dateLabel = formatDateLabel(draft.date);
        const options = draft.date
          ? await suggestTimes(draft.date, draft.serviceName, draft.serviceName ? undefined : 30)
          : [];
        const optionText = options.length ? ` Here are a few options: ${options.join(", ")}.` : "";
        const prefix = isVagueTime(body.message) ? "No problem—" : "";
        reply = `${prefix}What time works best on ${dateLabel}?${optionText}`;
      } else if (missing.includes("customerName")) {
        const dateLabel = formatDateLabel(draft.date);
        const timeLabel = formatTimeLabel(draft.time);
        reply = `Perfect — ${draft.serviceName} on ${dateLabel} at ${timeLabel}. What’s your first and last name?`;
      } else if (missing.includes("customerPhone")) {
        const name = draft.customerName ? draft.customerName.split(" ")[0] : "";
        reply = `${name ? `Thanks, ${name}. ` : ""}What’s the best phone number to confirm your appointment?`;
      } else if (missing.includes("customerEmail")) {
        const name = draft.customerName ? draft.customerName.split(" ")[0] : "";
        reply = `${name ? `Thanks, ${name}. ` : ""}What email should we use for the confirmation?`;
      } else {
        reply = nextQuestion(missing);
      }
    } else {
      // All fields collected
      if (draft.confirmed) {
        const result = await validateAndSave(draft);

        if (!result.ok) {
          // confirmation attempted but invalid → guide user naturally
          let updatedDraft: Draft = { ...draft, confirmed: false };
          const options = draft.date
            ? await suggestTimes(draft.date, draft.serviceName, draft.serviceName ? undefined : 30)
            : [];
          const optionText = options.length ? ` Try: ${options.join(", ")}.` : "";
          if (/opens at/i.test(result.reason) || /closes at/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, time: undefined };
            reply = `Sorry — ${result.reason} What time works for you on ${formatDateLabel(draft.date)}?${optionText}`;
          } else if (/closed that day/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, date: undefined, time: undefined };
            reply = `Sorry — ${result.reason} What day would you like instead?`;
          } else if (/already taken/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, time: undefined };
            reply = `${result.reason} What time would you like instead?${optionText}`;
          } else if (/past/i.test(result.reason)) {
            updatedDraft = { ...updatedDraft, date: undefined, time: undefined };
            reply = `That time has already passed. What day and time work for you?`;
          } else {
            updatedDraft = { ...updatedDraft, date: undefined, time: undefined };
            reply = `I couldn’t book that yet: ${result.reason} What day and time work for you?`;
          }
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { bookingDraft: updatedDraft as any },
          });
        } else {
          const dateLabel = formatDateLabel(draft.date);
          const timeLabel = formatTimeLabel(draft.time);
          reply = `Period 🤏🏾 — You’re all set ✂️\nSee you ${dateLabel} at ${timeLabel}.\nThanks for booking.`;

          if (draft.customerEmail) {
            try {
              await sendBookingConfirmationEmail({
                to: draft.customerEmail,
                name: draft.customerName ?? "there",
                service: draft.serviceName ?? "your service",
                dateLabel,
                timeLabel,
                bookingId: result.bookingId,
              });
            } catch (err) {
              console.error("Email send failed:", err);
            }
          }

          if (draft.customerPhone) {
            try {
              await sendBookingConfirmationSms({
                to: draft.customerPhone,
                name: draft.customerName ?? "there",
                service: draft.serviceName ?? "your service",
                dateLabel,
                timeLabel,
              });
            } catch (err) {
              console.error("SMS send failed:", err);
            }
          }
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
