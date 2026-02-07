import { DateTime } from "luxon";

export const BUFFER_MIN = 5;
export const SAME_DAY_MIN_LEAD_MIN = 60;

export const SERVICES: Record<string, number> = {
  "Haircut (Standard)": 30,
  "Beard Trim": 15,
  "Wash & Style": 15,
  "Head Shave": 45,
  "Kids Haircut": 25,
  "Buzz Cut": 15,
};

export const HOURS: Record<
  string,
  { open: string; close: string } | null
> = {
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: { open: "09:00", close: "18:00" },
  thursday: { open: "10:00", close: "20:00" },
  friday: { open: "10:00", close: "20:00" },
  saturday: { open: "09:00", close: "16:00" },
  sunday: null,
};

export function getTz() {
  return process.env.SHOP_TIMEZONE || "America/Toronto";
}

export function parseStart(date: string, time: string) {
  const tz = getTz();
  // expects YYYY-MM-DD and HH:MM
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) return null;
  return dt;
}

export function minutesForService(serviceName: string) {
  return SERVICES[serviceName] ?? null;
}

export function isWithinBusinessHours(start: DateTime, end: DateTime) {
  const dayKey = start.toFormat("cccc").toLowerCase(); // "monday"
  const hours = HOURS[dayKey];
  if (!hours) return { ok: false as const, reason: "Shop is closed that day." };

  const isoDate = start.toISODate();
  if (!isoDate) return { ok: false as const, reason: "Invalid booking date." };

  const zone = start.zoneName ?? getTz();
  const open = DateTime.fromISO(`${isoDate}T${hours.open}`, { zone });
  const close = DateTime.fromISO(`${isoDate}T${hours.close}`, { zone });

  if (start < open) return { ok: false as const, reason: `Too early. Opens at ${hours.open}.` };
  if (end > close) return { ok: false as const, reason: `Too late. Closes at ${hours.close}.` };

  return { ok: true as const };
}

export function enforceSameDayLead(start: DateTime, now: DateTime) {
  if (start.toISODate() !== now.toISODate()) return { ok: true as const };
  const diffMin = start.diff(now, "minutes").minutes;
  if (diffMin < SAME_DAY_MIN_LEAD_MIN) {
    return { ok: false as const, reason: `Same-day bookings must be at least ${SAME_DAY_MIN_LEAD_MIN} minutes in advance.` };
  }
  return { ok: true as const };
}
