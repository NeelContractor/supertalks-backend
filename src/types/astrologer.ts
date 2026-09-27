import { z } from "zod";

export const updateAstrologerProfileSchema = z.object({
  bio: z.string().max(2000).optional(),
  specializations: z.array(z.string()).max(10).optional(),
  languages: z.array(z.string()).max(10).optional(),
  experienceYears: z.number().int().min(0).max(80).optional(),
  timezone: z.string().optional(),
  /** Shows a free-text question box under the prefilled ones on the public site. */
  allowCustomQuestions: z.boolean().optional(),
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

/**
 * The 7-step astrologer registration form. The wizard is deliberately
 * permissive (`.passthrough`) so a step can grow new inputs without a
 * migration, but the fields we also copy onto AstrologerProfile are validated
 * strictly, and the whole document is size-capped so the JSONB column can't be
 * used to store arbitrary junk.
 */
const MAX_APPLICATION_BYTES = 64 * 1024;
const MAX_SERVICES = 20;

const applicationServiceSchema = z.object({
  name: z.string().trim().max(120),
  description: z.string().trim().max(1000).default(""),
  duration: z.string().trim().max(40).default(""),
  price: z.string().trim().max(20).default(""),
  mode: z.enum(["Online", "Offline"]).default("Online"),
  availableDays: z.string().trim().max(120).default(""),
  availableTime: z.string().trim().max(120).default(""),
});

export const astrologerApplicationSchema = z
  .object({
    // Step 1 — account (already known from the user row; kept for the review trail)
    fullName: z.string().trim().min(2).max(120).default(""),
    email: z.string().trim().toLowerCase().email().default(""),
    mobile: z.string().trim().max(20).default(""),
    country: z.string().trim().max(80).default(""),
    ageConfirmed: z.boolean().default(false),
    infoAccurate: z.boolean().default(false),

    // Step 2 — profile. These four are mirrored onto AstrologerProfile.
    displayName: z.string().trim().max(120).default(""),
    city: z.string().trim().max(80).default(""),
    languages: z.string().trim().max(200).default(""),
    yearsExperience: z.coerce.number().int().min(0).max(80).default(0),
    specialties: z.array(z.string().trim().max(60)).max(12).default([]),
    shortBio: z.string().trim().max(200).default(""),
    detailedIntro: z.string().trim().max(2000).default(""),

    // Steps 3-7 — website, services, payment, KYC, agreements. Stored verbatim
    // for staff review; never mapped onto other tables.
    websiteUrl: z.string().trim().max(200).default(""),
    heroHeadline: z.string().trim().max(200).default(""),
    heroDescription: z.string().trim().max(500).default(""),
    coverImage: z.string().trim().max(500).default(""),
    aboutMe: z.string().trim().max(2000).default(""),
    aboutExperience: z.string().trim().max(2000).default(""),
    approach: z.string().trim().max(2000).default(""),
    whatsapp: z.string().trim().max(20).default(""),
    contactEmail: z.string().trim().max(200).default(""),
    siteCity: z.string().trim().max(80).default(""),
    siteCountry: z.string().trim().max(80).default(""),

    services: z.array(applicationServiceSchema).max(MAX_SERVICES).default([]),

    legalName: z.string().trim().max(120).default(""),
    pan: z.string().trim().max(20).default(""),
    hasGst: z.enum(["yes", "no"]).default("no"),
    gstin: z.string().trim().max(20).default(""),
    businessName: z.string().trim().max(160).default(""),
    bankAccountHolder: z.string().trim().max(120).default(""),
    bankAccountNumber: z.string().trim().max(40).default(""),
    ifsc: z.string().trim().max(20).default(""),
    upi: z.string().trim().max(80).default(""),
    billingAddress: z.string().trim().max(500).default(""),

    kycPan: z.string().trim().max(20).default(""),
    govId: z.string().trim().max(40).default(""),
    selfieUploaded: z.boolean().default(false),
    bankVerified: z.boolean().default(false),
    astrologyCertificate: z.string().trim().max(500).default(""),
    diploma: z.string().trim().max(500).default(""),
    trainingCertificate: z.string().trim().max(500).default(""),
    experienceProof: z.string().trim().max(500).default(""),
    existingProfile: z.string().trim().max(200).default(""),

    agreeTerms: z.boolean().default(false),
    agreePrivacy: z.boolean().default(false),
    agreeDisclaimer: z.boolean().default(false),
    agreeRefund: z.boolean().default(false),
    agreeAccuracy: z.boolean().default(false),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_APPLICATION_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Registration details are too large to submit",
      });
    }
  });
export type AstrologerApplicationInput = z.infer<typeof astrologerApplicationSchema>;