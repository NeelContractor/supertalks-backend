import type {
  AvailabilityRule,
  AvailabilityException,
} from "@prisma/client";

export interface OpenSlot {
  startAt: string;
  endAt: string;
}

interface ProfileLike {
  slotDurationMinutes: number;
  bufferMinutes: number;
}

interface TimeWindow {
  startTime: Date;
  endTime: Date;
}

export function timeToMinutes(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
}

/** Parse an "HH:MM" (or "HH:MM:SS") string into minutes after midnight. */
export function hhmmToMinutes(t: string): number {
  const [h = "0", m = "0"] = t.split(":");
  return Number(h) * 60 + Number(m);
}

/** Render minutes after midnight as "HH:MM". */
export function minutesToHhmm(mins: number): string {
  const total = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The time-of-day window an exception covers (full day when times are omitted). */
export function exceptionWindowMinutes(exception: {
  startTime: Date | null;
  endTime: Date | null;
}): { start: number; end: number } {
  return {
    start: exception.startTime ? timeToMinutes(exception.startTime) : 0,
    end: exception.endTime ? timeToMinutes(exception.endTime) : 24 * 60,
  };
}

/**
 * Remove [cutStart, cutEnd) from [ruleStart, ruleEnd), returning the remaining
 * windows (0-2 of them). Used to trim a weekly rule around an exception.
 */
export function subtractWindow(
  ruleStart: number,
  ruleEnd: number,
  cutStart: number,
  cutEnd: number
): { start: number; end: number }[] {
  if (!windowsOverlap(ruleStart, ruleEnd, cutStart, cutEnd)) {
    return [{ start: ruleStart, end: ruleEnd }];
  }
  const remaining: { start: number; end: number }[] = [];
  if (cutStart > ruleStart) {
    remaining.push({ start: ruleStart, end: Math.min(cutStart, ruleEnd) });
  }
  if (cutEnd < ruleEnd) {
    remaining.push({ start: Math.max(cutEnd, ruleStart), end: ruleEnd });
  }
  return remaining.filter((w) => w.start < w.end);
}

/** True when [aStart, aEnd) and [bStart, bEnd) share time. */
export function windowsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Merge overlapping/adjacent windows so a day never yields duplicate slots. */
export function mergeWindows(windows: TimeWindow[]): TimeWindow[] {
  const sorted = [...windows].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  const merged: TimeWindow[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && timeToMinutes(w.startTime) < timeToMinutes(last.endTime)) {
      if (timeToMinutes(w.endTime) > timeToMinutes(last.endTime)) {
        last.endTime = w.endTime;
      }
    } else {
      merged.push({ startTime: w.startTime, endTime: w.endTime });
    }
  }
  return merged;
}

/**
 * Compute the open booking slots for an astrologer on a given UTC date.
 * Mirrors the public `GET /astrologers/:slug/slots` logic so booking
 * validation stays consistent with what the site renders.
 *
 * Exceptions always override weekly rules for their date (blocked wins),
 * so rules and exceptions can never clash.
 */
export function openSlotsForRules(
  profile: ProfileLike,
  rules: AvailabilityRule[],
  exceptions: AvailabilityException[],
  date: string
): OpenSlot[] {
  const target = new Date(`${date}T00:00:00Z`);
  const targetDay = target.getUTCDay();

  const blockedException = exceptions.find((e) => e.isBlocked);
  if (blockedException) return [];

  const exception = exceptions.find((e) => !e.isBlocked);
  const dayWindows = exception
    ? [
        {
          startTime: exception.startTime ?? new Date(`1970-01-01T00:00:00Z`),
          endTime: exception.endTime ?? new Date(`1970-01-01T23:59:00Z`),
        },
      ]
    : mergeWindows(
        rules
          .filter((r) => r.isActive && r.dayOfWeek === targetDay)
          .map((r) => ({ startTime: r.startTime, endTime: r.endTime }))
      );

  const slotDuration = profile.slotDurationMinutes;
  const buffer = profile.bufferMinutes;
  const slots: OpenSlot[] = [];

  for (const window of dayWindows) {
    const start = new Date(target);
    start.setUTCHours(
      window.startTime.getUTCHours(),
      window.startTime.getUTCMinutes(),
      0,
      0
    );
    const end = new Date(target);
    end.setUTCHours(
      window.endTime.getUTCHours(),
      window.endTime.getUTCMinutes(),
      0,
      0
    );

    let slotStart = new Date(start);
    while (slotStart.getTime() + slotDuration * 60000 <= end.getTime()) {
      const slotEnd = new Date(slotStart.getTime() + slotDuration * 60000);
      slots.push({
        startAt: slotStart.toISOString(),
        endAt: slotEnd.toISOString(),
      });
      slotStart = new Date(slotEnd.getTime() + buffer * 60000);
    }
  }

  return slots;
}