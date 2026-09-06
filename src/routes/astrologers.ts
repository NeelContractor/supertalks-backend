import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { requireAuth } from "../lib/middleware";
import { signAccessToken } from "../lib/auth";
import { db } from "../../prisma/db";
import { UserRole } from "@prisma/client";
import { sendValidationError, paramString } from "../lib/http";
import {
  updateAstrologerProfileSchema,
  updatePricingSchema,
  updateTemplateDataSchema,
} from "../types/astrologer";
import {
  createAvailabilityRuleSchema,
  createExceptionSchema,
} from "../types/scheduling";
import {
  buildSite,
  getDefaultRenderableTemplate,
  getTemplateSchema,
  sanitizeTemplateData,
} from "../lib/site";

const router = Router();

const updateProfilePartial = updateAstrologerProfileSchema.partial();
const updatePricingPartial = updatePricingSchema.partial();

async function getCurrentUser(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      role: true,
      profileImageUrl: true,
    },
  });

  if (!user || user.role !== UserRole.Astrologer) {
    return null;
  }
  return user;
}

async function getOwnProfile(userId: string) {
  const user = await getCurrentUser(userId);
  if (!user) return { error: "User is not an astrologer" };

  const profile = await db.astrologerProfile.findUnique({ where: { userId } });
  if (!profile) return { error: "Astrologer profile not found" };

  return { user, profile };
}

/**
 * @openapi
 * /astrologers/me:
 *   get:
 *     tags: [Astrologers]
 *     summary: Get own astrologer profile
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Own astrologer profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     name: { type: string }
 *                     email: { type: string, format: email }
 *                     username: { type: string }
 *                     role: { type: string }
 *                     profileImageUrl: { type: string, nullable: true }
 *                 profile:
 *                   type: object
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await getOwnProfile(req.user!.id);
    if ("error" in result) {
      const status = result.error === "Astrologer profile not found" ? 404 : 403;
      return res.status(status).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error("Get astrologer me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/stats:
 *   get:
 *     tags: [Astrologers]
 *     summary: Get dashboard stats (question counts, booking counts, earnings)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Stats }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       500: { description: Internal server error }
 */
router.get("/me/stats", requireAuth, async (req, res) => {
  try {
    const user = await getCurrentUser(req.user!.id);
    if (!user) return res.status(403).json({ error: "User is not an astrologer" });

    const profile = await db.astrologerProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!profile) return res.status(403).json({ error: "User is not an astrologer" });

    const astrologerId = profile.id;
    const now = new Date();

    const [
      pendingQuestions,
      answeredQuestions,
      rejectedQuestions,
      totalQuestions,
      upcomingBookings,
      completedBookings,
      totalBookings,
      earnings,
    ] = await Promise.all([
      db.question.count({ where: { astrologerId, status: "Queued" } }),
      db.question.count({ where: { astrologerId, status: "Answered" } }),
      db.question.count({ where: { astrologerId, status: "Rejected" } }),
      db.question.count({ where: { astrologerId } }),
      db.booking.count({
        where: { astrologerId, status: "Confirmed", startAt: { gt: now } },
      }),
      db.booking.count({ where: { astrologerId, status: "Completed" } }),
      db.booking.count({ where: { astrologerId } }),
      db.booking.aggregate({
        where: { astrologerId, status: "Completed" },
        _sum: { pricePaise: true },
      }),
    ]);

    return res.json({
      pendingQuestions,
      answeredQuestions,
      rejectedQuestions,
      totalQuestions,
      upcomingBookings,
      completedBookings,
      totalBookings,
      totalEarningsPaise: earnings._sum.pricePaise ?? 0,
    });
  } catch (err) {
    console.error("Get astrologer stats error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/onboard:
 *   post:
 *     tags: [Astrologers]
 *     summary: Onboard as an astrologer (promotes Client role and creates profile)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Astrologer profile created
 *       400: { description: Already an astrologer }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.post("/onboard", requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, role: true },
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    if (user.role === UserRole.Astrologer) {
      return res.status(400).json({ error: "Already an astrologer" });
    }

    const slug = `astro-${randomBytes(4).toString("hex")}`;

    const [updatedUser, profile] = await db.$transaction([
      db.user.update({
        where: { id: user.id },
        data: { role: UserRole.Astrologer },
        select: { id: true, name: true, email: true, username: true, role: true, profileImageUrl: true },
      }),
      db.astrologerProfile.create({
        data: {
          userId: user.id,
          slug,
          timezone: "Asia/Kolkata",
        },
      }),
    ]);

    const accessToken = await signAccessToken(updatedUser.id, updatedUser.role);

    return res.status(201).json({ user: updatedUser, profile, accessToken });
  } catch (err) {
    console.error("Onboard astrologer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me:
 *   patch:
 *     tags: [Astrologers]
 *     summary: Update own astrologer profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bio: { type: string, maxLength: 2000 }
 *               specializations: { type: array, items: { type: string }, maxItems: 10 }
 *               languages: { type: array, items: { type: string }, maxItems: 10 }
 *               experienceYears: { type: integer, minimum: 0, maximum: 80 }
 *               timezone: { type: string }
 *     responses:
 *       200: { description: Profile updated }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.patch("/me", requireAuth, async (req, res) => {
  try {
    const parsed = updateProfilePartial.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const data = parsed.data;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }

    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({ where: { userId } });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const updated = await db.astrologerProfile.update({ where: { userId }, data });
    return res.json({ profile: updated });
  } catch (err) {
    console.error("Update astrologer me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/pricing:
 *   patch:
 *     tags: [Astrologers]
 *     summary: Update own astrologer pricing (all values in paise)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               questionPricePaise: { type: integer, minimum: 0 }
 *               callPricePerSlotPaise: { type: integer, minimum: 0 }
 *               slotDurationMinutes: { type: integer, enum: [15, 20, 30, 45, 60] }
 *               bufferMinutes: { type: integer, minimum: 0, maximum: 60 }
 *     responses:
 *       200: { description: Pricing updated }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.patch("/me/pricing", requireAuth, async (req, res) => {
  try {
    const parsed = updatePricingPartial.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const data = parsed.data;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No pricing fields provided" });
    }

    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({ where: { userId } });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const updated = await db.astrologerProfile.update({ where: { userId }, data });
    return res.json({ profile: updated });
  } catch (err) {
    console.error("Update astrologer pricing error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/availability-rules:
 *   get:
 *     tags: [Astrologers]
 *     summary: List own availability rules
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: List of availability rules }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       500: { description: Internal server error }
 */
router.get("/me/availability-rules", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const rules = await db.availabilityRule.findMany({
      where: { astrologerId: profile.id },
      orderBy: { dayOfWeek: "asc" },
    });
    return res.json({ rules });
  } catch (err) {
    console.error("List availability rules error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/availability-rules:
 *   post:
 *     tags: [Astrologers]
 *     summary: Create an availability rule
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [dayOfWeek, startTime, endTime]
 *             properties:
 *               dayOfWeek: { type: integer, minimum: 0, maximum: 6 }
 *               startTime: { type: string, example: "09:00" }
 *               endTime: { type: string, example: "17:00" }
 *     responses:
 *       201: { description: Availability rule created }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.post("/me/availability-rules", requireAuth, async (req, res) => {
  try {
    const parsed = createAvailabilityRuleSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const { dayOfWeek, startTime, endTime } = parsed.data;
    const rule = await db.availabilityRule.create({
      data: {
        astrologerId: profile.id,
        dayOfWeek,
        startTime: new Date(`1970-01-01T${startTime}`),
        endTime: new Date(`1970-01-01T${endTime}`),
      },
    });

    return res.status(201).json({ rule });
  } catch (err) {
    console.error("Create availability rule error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/availability-rules/{id}:
 *   patch:
 *     tags: [Astrologers]
 *     summary: Update an availability rule
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               dayOfWeek: { type: integer, minimum: 0, maximum: 6 }
 *               startTime: { type: string, example: "09:00" }
 *               endTime: { type: string, example: "17:00" }
 *               isActive: { type: boolean }
 *     responses:
 *       200: { description: Availability rule updated }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: Rule not found }
 *       500: { description: Internal server error }
 */
router.patch(
  "/me/availability-rules/:id",
  requireAuth,
  async (req, res) => {
    try {
      const parsed = createAvailabilityRuleSchema
        .extend({ isActive: z.boolean().optional() })
        .partial()
        .safeParse(req.body);
      if (!parsed.success) return sendValidationError(res, parsed.error);

      const ruleId = paramString(req.params.id);
      if (!ruleId) return res.status(400).json({ error: "Invalid rule id" });

      const userId = req.user!.id;
      const profile = await db.astrologerProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!profile) {
        const user = await getCurrentUser(userId);
        if (!user) return res.status(403).json({ error: "User is not an astrologer" });
        return res.status(404).json({ error: "Astrologer profile not found" });
      }

      const existing = await db.availabilityRule.findFirst({
        where: { id: ruleId, astrologerId: profile.id },
      });
      if (!existing) return res.status(404).json({ error: "Availability rule not found" });

      const data: Record<string, unknown> = { ...parsed.data };
      if (data.startTime) data.startTime = new Date(`1970-01-01T${data.startTime}`);
      if (data.endTime) data.endTime = new Date(`1970-01-01T${data.endTime}`);

      const rule = await db.availabilityRule.update({
        where: { id: existing.id },
        data,
      });

      return res.json({ rule });
    } catch (err) {
      console.error("Update availability rule error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * @openapi
 * /astrologers/me/availability-rules/{id}:
 *   delete:
 *     tags: [Astrologers]
 *     summary: Delete an availability rule
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Availability rule deleted }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: Rule not found }
 *       500: { description: Internal server error }
 */
router.delete(
  "/me/availability-rules/:id",
  requireAuth,
  async (req, res) => {
    try {
      const ruleId = paramString(req.params.id);
      if (!ruleId) return res.status(400).json({ error: "Invalid rule id" });

      const userId = req.user!.id;
      const profile = await db.astrologerProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!profile) {
        const user = await getCurrentUser(userId);
        if (!user) return res.status(403).json({ error: "User is not an astrologer" });
        return res.status(404).json({ error: "Astrologer profile not found" });
      }

      const existing = await db.availabilityRule.findFirst({
        where: { id: ruleId, astrologerId: profile.id },
      });
      if (!existing) return res.status(404).json({ error: "Availability rule not found" });

      await db.availabilityRule.delete({ where: { id: existing.id } });
      return res.json({ message: "Availability rule deleted" });
    } catch (err) {
      console.error("Delete availability rule error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * @openapi
 * /astrologers/me/exceptions:
 *   get:
 *     tags: [Astrologers]
 *     summary: List own availability exceptions
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: List of exceptions }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.get("/me/exceptions", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const exceptions = await db.availabilityException.findMany({
      where: { astrologerId: profile.id },
      orderBy: { date: "asc" },
    });
    return res.json({ exceptions });
  } catch (err) {
    console.error("List exceptions error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/exceptions:
 *   post:
 *     tags: [Astrologers]
 *     summary: Create an availability exception
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [date, isBlocked]
 *             properties:
 *               date: { type: string, format: date, example: "2026-09-10" }
 *               isBlocked: { type: boolean }
 *               startTime: { type: string, nullable: true, example: "09:00" }
 *               endTime: { type: string, nullable: true, example: "17:00" }
 *               reason: { type: string, nullable: true }
 *     responses:
 *       201: { description: Exception created }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.post("/me/exceptions", requireAuth, async (req, res) => {
  try {
    const parsed = createExceptionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const { date, isBlocked, startTime, endTime, reason } = parsed.data;
    const exception = await db.availabilityException.create({
      data: {
        astrologerId: profile.id,
        date: new Date(`${date}T00:00:00`),
        isBlocked,
        startTime: startTime ? new Date(`1970-01-01T${startTime}`) : null,
        endTime: endTime ? new Date(`1970-01-01T${endTime}`) : null,
        reason,
      },
    });

    return res.status(201).json({ exception });
  } catch (err) {
    console.error("Create exception error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/exceptions/{id}:
 *   delete:
 *     tags: [Astrologers]
 *     summary: Delete an availability exception
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Exception deleted }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: Exception not found }
 *       500: { description: Internal server error }
 */
router.delete("/me/exceptions/:id", requireAuth, async (req, res) => {
  try {
    const exceptionId = paramString(req.params.id);
    if (!exceptionId) return res.status(400).json({ error: "Invalid exception id" });

    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const existing = await db.availabilityException.findFirst({
      where: { id: exceptionId, astrologerId: profile.id },
    });
    if (!existing) return res.status(404).json({ error: "Exception not found" });

    await db.availabilityException.delete({ where: { id: existing.id } });
    return res.json({ message: "Exception deleted" });
  } catch (err) {
    console.error("Delete exception error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/template-data:
 *   patch:
 *     tags: [Astrologers]
 *     summary: Update own website template data
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               templateId: { type: string, format: uuid, nullable: true }
 *               templateData: { type: object, additionalProperties: true }
 *     responses:
 *       200: { description: Template data updated }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.patch("/me/template-data", requireAuth, async (req, res) => {
  try {
    const parsed = updateTemplateDataSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        templateId: true,
        templateData: true,
        slug: true,
      },
    });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    let templateId = parsed.data.templateId ?? profile.templateId;
    if (templateId) {
      const template = await db.websiteTemplate.findUnique({
        where: { id: templateId },
      });
      if (!template) {
        return res.status(400).json({ error: "Template not found" });
      }
    }

    const template = templateId
      ? await db.websiteTemplate.findUnique({ where: { id: templateId } })
      : await getDefaultRenderableTemplate();
    if (!template) {
      return res.status(500).json({ error: "No website template available" });
    }

    const schema = getTemplateSchema(template);
    const sanitized = sanitizeTemplateData(schema, parsed.data.templateData ?? {});

    const updated = await db.astrologerProfile.update({
      where: { userId },
      data: {
        templateId,
        templateData: sanitized as never,
      },
      select: {
        id: true,
        templateId: true,
        templateData: true,
        slug: true,
      },
    });

    const siteResult = await buildSite(updated);
    return res.json({ profile: updated, site: siteResult.site });
  } catch (err) {
    console.error("Update template data error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/me/site:
 *   get:
 *     tags: [Astrologers]
 *     summary: Get own customised website (template schema + merged site doc)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Template schema and fully-merged site document
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.get("/me/site", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: {
        slug: true,
        templateId: true,
        templateData: true,
        user: { select: { name: true, username: true, profileImageUrl: true } },
      },
    });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    const { template, schema, site } = await buildSite(profile);
    return res.json({
      slug: profile.slug,
      astrologerName: profile.user.name,
      templateId: template.id,
      templateName: template.name,
      templatePreviewImageUrl: template.previewImageUrl,
      schema,
      site,
    });
  } catch (err) {
    console.error("Get own site error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/{slug}/site:
 *   get:
 *     tags: [Astrologers]
 *     summary: Get a public astrologer's site (template schema + merged site doc) for rendering
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Template schema and fully-merged site document
 *       404: { description: Astrologer not found }
 *       500: { description: Internal server error }
 */
router.get("/:slug/site", async (req, res) => {
  try {
    const slug = paramString(req.params.slug);
    if (!slug) return res.status(404).json({ error: "Astrologer not found" });

    const profile = await db.astrologerProfile.findUnique({
      where: { slug },
      select: {
        slug: true,
        status: true,
        templateId: true,
        templateData: true,
        user: { select: { name: true, username: true, profileImageUrl: true } },
      },
    });
    if (!profile) {
      return res.status(404).json({ error: "Astrologer not found" });
    }

    const { template, schema, site } = await buildSite(profile);
    return res.json({
      slug: profile.slug,
      astrologerName: profile.user.name,
      templateId: template.id,
      templateName: template.name,
      templatePreviewImageUrl: template.previewImageUrl,
      schema,
      site,
    });
  } catch (err) {
    console.error("Get public site error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/{slug}/slots:
 *   get:
 *     tags: [Astrologers]
 *     summary: Get open slots for an astrologer on a given date
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: date
 *         required: true
 *         schema: { type: string, format: date, example: "2026-09-10" }
 *     responses:
 *       200:
 *         description: List of open slots
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 date: { type: string }
 *                 slots:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       startAt: { type: string, format: date-time }
 *                       endAt: { type: string, format: date-time }
 *       400: { description: Missing or invalid date }
 *       404: { description: Astrologer not found }
 *       500: { description: Internal server error }
 */
router.get("/:slug/slots", async (req, res) => {
  try {
    const { date } = req.query;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date is required in YYYY-MM-DD format" });
    }

    const profile = await db.astrologerProfile.findUnique({
      where: { slug: req.params.slug },
      include: {
        availabilityRules: { where: { isActive: true } },
        availabilityExceptions: { where: { date: new Date(`${date}T00:00:00`) } },
      },
    });

    if (!profile) {
      return res.status(404).json({ error: "Astrologer not found" });
    }

    const target = new Date(`${date}T00:00:00Z`);
    const targetDay = target.getUTCDay();

    const blockedException = profile.availabilityExceptions.find(
      (e) => e.isBlocked
    );
    if (blockedException) {
      return res.json({ date, slots: [] });
    }

    const exception = profile.availabilityExceptions.find((e) => !e.isBlocked);
    const dayRules = exception
      ? [
          {
            startTime: exception.startTime ?? new Date(`1970-01-01T00:00:00Z`),
            endTime: exception.endTime ?? new Date(`1970-01-01T23:59:00Z`),
          },
        ]
      : profile.availabilityRules.filter((r) => r.dayOfWeek === targetDay);

    const slotDuration = profile.slotDurationMinutes;
    const buffer = profile.bufferMinutes;
    const slots: { startAt: string; endAt: string }[] = [];

    for (const rule of dayRules) {
      const start = new Date(target);
      start.setUTCHours(rule.startTime.getUTCHours(), rule.startTime.getUTCMinutes(), 0, 0);
      const end = new Date(target);
      end.setUTCHours(rule.endTime.getUTCHours(), rule.endTime.getUTCMinutes(), 0, 0);

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

    return res.json({ date, slots });
  } catch (err) {
    console.error("Get slots error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/{slug}:
 *   get:
 *     tags: [Astrologers]
 *     summary: Get a public astrologer profile by slug (for the rendered site)
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Public astrologer profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     name: { type: string }
 *                     username: { type: string }
 *                     profileImageUrl: { type: string, nullable: true }
 *                 profile:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     slug: { type: string }
 *                     status: { type: string }
 *                     bio: { type: string, nullable: true }
 *                     specializations: { type: array, items: { type: string } }
 *                     languages: { type: array, items: { type: string } }
 *                     experienceYears: { type: integer, nullable: true }
 *                     timezone: { type: string }
 *                     questionPricePaise: { type: integer }
 *                     callPricePerSlotPaise: { type: integer }
 *                     isAcceptingQuestions: { type: boolean }
 *                     isAcceptingBookings: { type: boolean }
 *                     templateData: { type: object }
 *       404: { description: Astrologer not found }
 *       500: { description: Internal server error }
 */
router.get("/:slug", async (req, res) => {
  try {
    const slug = paramString(req.params.slug);
    if (!slug) {
      return res.status(404).json({ error: "Astrologer not found" });
    }

    const profile = await db.astrologerProfile.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        status: true,
        bio: true,
        specializations: true,
        languages: true,
        experienceYears: true,
        timezone: true,
        questionPricePaise: true,
        callPricePerSlotPaise: true,
        isAcceptingQuestions: true,
        isAcceptingBookings: true,
        templateData: true,
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            profileImageUrl: true,
          },
        },
      },
    });

    if (!profile) {
      return res.status(404).json({ error: "Astrologer not found" });
    }

    const { user, ...profileData } = profile;
    return res.json({ user, profile: profileData });
  } catch (err) {
    console.error("Get public astrologer by slug error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
