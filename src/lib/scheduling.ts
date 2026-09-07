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