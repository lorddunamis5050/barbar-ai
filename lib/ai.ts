import OpenAI from "openai";
import { DateTime } from "luxon";
import { getTz } from "@/lib/bookingRules";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is not set in environment variables");
}

const client = new OpenAI({ apiKey });

export type ExtractedBooking = {
  serviceName?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  confirmed?: boolean;
};

const SERVICES = [
  "Haircut (Standard)",
  "Beard Trim",
  "Wash & Style",
  "Head Shave",
  "Kids Haircut",
  "Buzz Cut",
];

export async function extractBookingInfo(
  message: string,
  previousData: ExtractedBooking
): Promise<ExtractedBooking> {
  const tz = getTz();
  const today = DateTime.now().setZone(tz).toISODate();
  const now = DateTime.now().setZone(tz).toFormat("yyyy-LL-dd HH:mm");
  const prompt = `You are a helpful barbershop booking assistant. Extract booking information from the user's message.

Today is ${today}. Current local time is ${now} (${tz}).

Services available: ${SERVICES.join(", ")}

Already collected data:
- Service: ${previousData.serviceName || "Not provided"}
- Date: ${previousData.date || "Not provided"}
- Time: ${previousData.time || "Not provided"}
- Name: ${previousData.customerName || "Not provided"}
- Phone: ${previousData.customerPhone || "Not provided"}
- Email: ${previousData.customerEmail || "Not provided"}

User message: "${message}"

Extract any NEW booking information from the user's message. Only update fields that the user explicitly provides in this message.
Respond with a JSON object containing only the fields you found:
{
  "serviceName": "service name from our list or null",
  "date": "YYYY-MM-DD format or null",
  "time": "HH:MM 24-hour format or null",
  "customerName": "full name or null",
  "customerPhone": "phone number or null",
  "customerEmail": "email or null",
  "confirmed": true/false/null
}

Rules:
- Date must be YYYY-MM-DD format
- Time must be HH:MM 24-hour format (14:30, not 2:30 PM)
- Phone can be any common format
- Only include fields where you found new information
- If user says "confirm", "yes", "sounds good", or similar, set confirmed to true
- If user says "no", "cancel", "nevermind", set confirmed to false
- Return only valid JSON, no other text`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "You extract structured booking info for a barbershop." },
      { role: "user", content: prompt },
    ],
  });

  const responseText = response.choices[0]?.message?.content ?? "";

  let extracted: Record<string, any> = {};
  try {
    // Find JSON in response (might have extra text)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      extracted = JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.error("Failed to parse LLM response:", responseText, error);
    return previousData;
  }

  // Merge with previous data, keeping non-null new values
  const result: ExtractedBooking = { ...previousData };

  if (extracted.serviceName) result.serviceName = extracted.serviceName;
  if (extracted.date) result.date = extracted.date;
  if (extracted.time) result.time = extracted.time;
  if (extracted.customerName) result.customerName = extracted.customerName;
  if (extracted.customerPhone) result.customerPhone = extracted.customerPhone;
  if (extracted.customerEmail) result.customerEmail = extracted.customerEmail;
  if (extracted.confirmed !== null && extracted.confirmed !== undefined) {
    result.confirmed = extracted.confirmed;
  }

  // Fallbacks for relative dates and AM/PM times
  const lower = message.toLowerCase();

  const weekdayMap: Record<string, number> = {
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
    sunday: 7,
  };

  const nowDt = DateTime.now().setZone(tz);
  let computedDate: string | null = null;

  if (/\btomorrow\b/.test(lower)) {
    computedDate = nowDt.plus({ days: 1 }).toISODate();
  } else if (/\btoday\b/.test(lower)) {
    computedDate = nowDt.toISODate();
  } else {
    const weekdayMatch = lower.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (weekdayMatch) {
      const weekday = weekdayMap[weekdayMatch[2]];
      let daysToAdd = (weekday - nowDt.weekday + 7) % 7;
      if (daysToAdd === 0) daysToAdd = 7;
      computedDate = nowDt.plus({ days: daysToAdd }).toISODate();
    }
  }

  if (computedDate) {
    const parsed = DateTime.fromISO(computedDate, { zone: tz });
    const extractedDate = result.date ? DateTime.fromISO(result.date, { zone: tz }) : null;
    if (!result.date || !extractedDate || !extractedDate.isValid || extractedDate.weekday !== parsed.weekday) {
      result.date = computedDate;
    }
  }

  if (!result.time) {
    if (/\bnoon\b/.test(lower)) {
      result.time = "12:00";
    } else if (/\bmidnight\b/.test(lower)) {
      result.time = "00:00";
    } else {
      const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3];
        if (ampm === "pm" && hour < 12) hour += 12;
        if (ampm === "am" && hour === 12) hour = 0;
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          result.time = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
        }
      }
    }
  }

  if (result.confirmed === undefined) {
    if (/\b(confirm|confrim|confim|condim|cnofirm|yes|sounds good|book it)\b/i.test(message)) {
      result.confirmed = true;
    }
    if (/\b(cancel|nope|no|never\s*mind|stop)\b/i.test(message)) {
      result.confirmed = false;
    }
  }

  return result;
}
