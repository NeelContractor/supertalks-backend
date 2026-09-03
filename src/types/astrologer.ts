import { z } from "zod";

export const updateAstrologerProfileSchema = z.object({
  bio: z.string().max(2000).optional(),
  specializations: z.array(z.string()).max(10).optional(),
  languages: z.array(z.string()).max(10).optional(),
  experienceYears: z.number().int().min(0).max(80).optional(),
  timezone: z.string().optional(),
});
export type UpdateAstrologerProfileInput = z.infer<typeof updateAstrologerProfileSchema>;

export const updatePricingSchema = z.object({
  questionPricePaise: z.number().int().min(0),
  callPricePerSlotPaise: z.number().int().min(0),
  slotDurationMinutes: z.number().int().refine((v: number) => [15, 20, 30, 45, 60].includes(v)),
  bufferMinutes: z.number().int().min(0).max(60),
});
export type UpdatePricingInput = z.infer<typeof updatePricingSchema>;

export const updateTemplateDataSchema = z.object({
  templateId: z.string().uuid().optional(),
  templateData: z.record(z.string(), z.any()),  // validated against websiteTemplates.schema server-side, not by Zod
});
export type UpdateTemplateDataInput = z.infer<typeof updateTemplateDataSchema>;