import { z } from "zod";

export const createAvailabilityRuleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
}).refine(d => d.startTime < d.endTime, { message: "startTime must be before endTime" });

export const createExceptionSchema = z.object({
  date: z.string().date(),   // 'YYYY-MM-DD'
  isBlocked: z.boolean(),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  reason: z.string().max(200).optional(),
});

export const createBookingSchema = z.object({
  astrologerId: z.string().uuid(),
  startAt: z.string().datetime(),   // ISO 8601 UTC, computed client-side from a chosen local slot
});

export const rescheduleBookingSchema = z.object({
  newStartAt: z.string().datetime(),
});

export const cancelBookingSchema = z.object({
  reason: z.string().max(300).optional(),
});