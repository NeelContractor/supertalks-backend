import { z } from "zod";

const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;

const timeWindow = z.object({
  startTime: z.string().regex(timeRegex),
  endTime: z.string().regex(timeRegex),
});

export const createAvailabilityRuleSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(timeRegex),
    endTime: z.string().regex(timeRegex),
  })
  .refine((d) => d.startTime < d.endTime, {
    message: "startTime must be before endTime",
  });

/** Replaces the weekly rules for the given days with the given windows (one action). */
export const bulkAvailabilityRulesSchema = z.object({
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .refine((days) => new Set(days).size === days.length, {
      message: "daysOfWeek must not contain duplicates",
    }),
  windows: z
    .array(timeWindow)
    .refine(
      (windows) => windows.every((w) => w.startTime < w.endTime),
      { message: "each startTime must be before its endTime" }
    )
    .refine(
      (windows) =>
        windows.every((w, i) =>
          windows
            .slice(i + 1)
            .every((o) => !(w.startTime < o.endTime && o.startTime < w.endTime))
        ),
      { message: "windows must not overlap each other" }
    ),
});

export const createExceptionSchema = z
  .object({
    date: z.string().date(), // 'YYYY-MM-DD'
    isBlocked: z.boolean(),
    startTime: z.string().regex(timeRegex).optional(),
    endTime: z.string().regex(timeRegex).optional(),
    reason: z.string().max(200).optional(),
  })
  .refine(
    (d) =>
      d.isBlocked
        ? (!d.startTime && !d.endTime) ||
          (!!d.startTime && !!d.endTime && d.startTime < d.endTime)
        : !!d.startTime && !!d.endTime && d.startTime < d.endTime,
    { message: "Adjusted exceptions require startTime and endTime (startTime before endTime); blocked exceptions should not include times" }
  );

export const createBookingSchema = z.object({
  astrologerId: z.string().uuid(),
  startAt: z.string().datetime(), // ISO 8601 UTC, computed client-side from a chosen local slot
});

export const rescheduleBookingSchema = z.object({
  newStartAt: z.string().datetime(),
});

export const cancelBookingSchema = z.object({
  reason: z.string().max(300).optional(),
});