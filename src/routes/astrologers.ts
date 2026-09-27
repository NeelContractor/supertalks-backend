import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { requireAuth } from "../lib/middleware";
import { signAccessToken } from "../lib/auth";
import { db } from "../../prisma/db";
import { UserRole, BookingStatus, AstrologerApplicationStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { sendValidationError, paramString } from "../lib/http";
import {
  updateAstrologerProfileSchema,
  updatePricingSchema,
  updateTemplateDataSchema,
  astrologerApplicationSchema,
} from "../types/astrologer";
import type { AstrologerApplicationInput } from "../types/astrologer";
import {
  createAvailabilityRuleSchema,
  createExceptionSchema,
  bulkAvailabilityRulesSchema,
} from "../types/scheduling";
import {
  buildSite,
  getDefaultRenderableTemplate,
  getTemplateSchema,
  sanitizeTemplateData,
} from "../lib/site";
import {
  openSlotsForRules,
  timeToMinutes,
  windowsOverlap,
  hhmmToMinutes,
  minutesToHhmm,
  exceptionWindowMinutes,
  subtractWindow,
} from "../lib/scheduling";

const router = Router();

const updateProfilePartial = updateAstrologerProfileSchema.partial();
const updatePricingPartial = updatePricingSchema.partial();

interface RuleConflict {
  ruleId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

interface ExceptionConflict {
  exceptionId: string;
  date: string;
  isBlocked: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

const BOOKING_BLOCKING_STATUSES = [BookingStatus.Confirmed, BookingStatus.Rescheduled];

/**
 * Exceptions that fall on `dayOfWeek` (today or later) whose window overlaps
 * [startMin, endMin). Used to stop a weekly rule from being created on top of
 * a date-specific exception.
 */
async function findExceptionClashes(
  astrologerId: string,
  dayOfWeek: number,
  startMin: number,
  endMin: number
): Promise<ExceptionConflict[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const exceptions = await db.availabilityException.findMany({
    where: { astrologerId, date: { gte: todayStart } },
    select: {
      id: true,
      date: true,
      isBlocked: true,
      startTime: true,
      endTime: true,
      reason: true,
    },
  });

  return exceptions
    .filter((e) => {
      if (e.date.getUTCDay() !== dayOfWeek) return false;
      const { start, end } = exceptionWindowMinutes(e);
      return windowsOverlap(start, end, startMin, endMin);
    })
    .map((e) => ({
      exceptionId: e.id,
      date: e.date.toISOString().slice(0, 10),
      isBlocked: e.isBlocked,
      startTime: e.startTime ? minutesToHhmm(timeToMinutes(e.startTime)) : null,
      endTime: e.endTime ? minutesToHhmm(timeToMinutes(e.endTime)) : null,
      reason: e.reason,
    }));
}

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
 * Fields the /register form collects that also have a home on
 * AstrologerProfile. Mirroring them here means a submitted application
 * immediately shows up on the public profile and the dashboard.
 */
function profileFieldsFromApplication(data: AstrologerApplicationInput) {
  const languages = data.languages
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);

  const bio = data.detailedIntro || data.shortBio || data.aboutMe || null;

  return {
    bio,
    specializations: data.specialties,
    languages,
    experienceYears: data.yearsExperience > 0 ? data.yearsExperience : null,
  };
}

/**
 * @openapi
 * /astrologers/application:
 *   get:
 *     tags: [Astrologers]
 *     summary: Get own astrologer registration application
 *     description: >
 *       Returns the submission made through the 7-step /register form, or
 *       `application: null` when the user has not submitted one yet. The
 *       frontend uses the null check to decide whether to show /register.
 *       The payload contains bank/KYC details, so it is only ever returned to
 *       the user who submitted it.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Application or null
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 application:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     status: { type: string, enum: [Submitted, Approved, Rejected] }
 *                     payload: { type: object }
 *                     submittedAt: { type: string, format: date-time }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.get("/application", requireAuth, async (req, res) => {
  try {
    const application = await db.astrologerApplication.findUnique({
      where: { userId: req.user!.id },
    });

    return res.json({ application });
  } catch (err) {
    console.error("Get astrologer application error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /astrologers/application:
 *   post:
 *     tags: [Astrologers]
 *     summary: Submit (or re-submit) the astrologer registration application
 *     description: >
 *       Idempotent upsert keyed on the current user — submitting again
 *       overwrites the previous application, which is what "Edit application"
 *       on the confirmation screen does. Also mirrors the profile-level fields
 *       (bio, specializations, languages, experience) onto the profile.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [payload]
 *             properties:
 *               payload: { type: object, description: The 7-step form's field set }
 *     responses:
 *       201:
 *         description: Application submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 application: { type: object }
 *                 profile: { $ref: '#/components/schemas/AstrologerProfile' }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.post("/application", requireAuth, async (req, res) => {
  try {
    const parsed = astrologerApplicationSchema.safeParse(
      (req.body as { payload?: unknown })?.payload,
    );
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const data = parsed.data;
    const userId = req.user!.id;

    const profile = await db.astrologerProfile.findUnique({ where: { userId } });
    if (!profile) {
      const user = await getCurrentUser(userId);
      if (!user) return res.status(403).json({ error: "User is not an astrologer" });
      return res.status(404).json({ error: "Astrologer profile not found" });
    }

    // A re-submission restarts the review, so staff see the latest answers.
    const status =
      profile.status === "Approved" ? AstrologerApplicationStatus.Approved : AstrologerApplicationStatus.Submitted;

    // `.passthrough()` leaves an index signature on the inferred type, which
    // Prisma's Json input can't see through; the value is plain JSONB here.
    const payload = data as unknown as Prisma.InputJsonValue;

    const [application, updatedProfile] = await db.$transaction([
      db.astrologerApplication.upsert({
        where: { userId },
        create: { userId, payload, status },
        update: { payload, status, submittedAt: new Date() },
      }),
      db.astrologerProfile.update({
        where: { userId },
        data: profileFieldsFromApplication(data),
      }),
    ]);

    return res.status(201).json({ application, profile: updatedProfile });
  } catch (err) {
    console.error("Submit astrologer application error:", err);
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
 *               allowCustomQuestions:
 *                 type: boolean
 *                 description: Show a free-text question box on the public site
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
    const start = new Date(`1970-01-01T${startTime}`);
    const end = new Date(`1970-01-01T${endTime}`);

    const existing = await db.availabilityRule.findMany({
      where: { astrologerId: profile.id, dayOfWeek },
      select: { startTime: true, endTime: true },
    });
    if (
      existing.some((r) =>
        windowsOverlap(
          timeToMinutes(start),
          timeToMinutes(end),
          timeToMinutes(r.startTime),
          timeToMinutes(r.endTime)
        )
      )
    ) {
      return res
        .status(400)
        .json({ error: "Availability rule overlaps an existing rule for this day" });
    }

    const resolve = (req.body as { resolve?: unknown })?.resolve;
    const clashes = await findExceptionClashes(
      profile.id,
      dayOfWeek,
      hhmmToMinutes(startTime),
      hhmmToMinutes(endTime)
    );
    if (clashes.length > 0) {
      if (resolve !== "remove-exceptions") {
        return res.status(409).json({
          error: "This availability clashes with an exception on that day",
          code: "EXCEPTION_CONFLICT",
          conflicts: clashes,
        });
      }
      await db.availabilityException.deleteMany({
        where: { id: { in: clashes.map((c) => c.exceptionId) } },
      });
    }

    const rule = await db.availabilityRule.create({
      data: {
        astrologerId: profile.id,
        dayOfWeek,
        startTime: start,
        endTime: end,
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
 * /astrologers/me/availability-rules/bulk:
 *   post:
 *     tags: [Astrologers]
 *     summary: Replace weekly availability rules for the given days with the given windows
 *     description: Applied as one action - creates/updates rules to match the windows and removes any rule on the selected days not in the windows.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [daysOfWeek, windows]
 *             properties:
 *               daysOfWeek: { type: array, items: { type: integer, minimum: 0, maximum: 6 } }
 *               windows:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [startTime, endTime]
 *                   properties:
 *                     startTime: { type: string, example: "09:00" }
 *                     endTime: { type: string, example: "13:00" }
 *     responses:
 *       200: { description: Rules replaced }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: User is not an astrologer }
 *       404: { description: No astrologer profile found }
 *       500: { description: Internal server error }
 */
router.post("/me/availability-rules/bulk", requireAuth, async (req, res) => {
  try {
    const parsed = bulkAvailabilityRulesSchema.safeParse(req.body);
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

    const { daysOfWeek, windows } = parsed.data;
    const windowsForDay = (startTime: string, endTime: string) => ({
      startTime: new Date(`1970-01-01T${startTime}`),
      endTime: new Date(`1970-01-01T${endTime}`),
    });

    const resolve = (req.body as { resolve?: unknown })?.resolve;
    const clashes: ExceptionConflict[] = [];
    for (const day of daysOfWeek) {
      for (const w of windows) {
        const found = await findExceptionClashes(
          profile.id,
          day,
          hhmmToMinutes(w.startTime),
          hhmmToMinutes(w.endTime)
        );
        for (const c of found) {
          if (!clashes.some((x) => x.exceptionId === c.exceptionId)) clashes.push(c);
        }
      }
    }
    if (clashes.length > 0) {
      if (resolve !== "remove-exceptions") {
        return res.status(409).json({
          error: "This availability clashes with an exception on that day",
          code: "EXCEPTION_CONFLICT",
          conflicts: clashes,
        });
      }
      await db.availabilityException.deleteMany({
        where: { id: { in: clashes.map((c) => c.exceptionId) } },
      });
    }

    for (const day of daysOfWeek) {
      const existing = await db.availabilityRule.findMany({
        where: { astrologerId: profile.id, dayOfWeek: day },
        select: { id: true, startTime: true, endTime: true },
      });

      const windowsToUse = windows.map((w) => windowsForDay(w.startTime, w.endTime));
      const matches = new Set<string>();
      const kept: { id: string; startTime: Date; endTime: Date }[] = [];

      for (const rule of existing) {
        const matchIdx = windowsToUse.findIndex(
          (w) =>
            timeToMinutes(w.startTime) === timeToMinutes(rule.startTime) &&
            timeToMinutes(w.endTime) === timeToMinutes(rule.endTime)
        );
        const match = matchIdx >= 0 ? windowsToUse[matchIdx] : undefined;
        if (match) {
          matches.add(rule.id);
          kept.push({ id: rule.id, startTime: match.startTime, endTime: match.endTime });
          windowsToUse.splice(matchIdx, 1);
        }
      }

      if (windowsToUse.length > 0) {
        await db.$transaction(
          windowsToUse.map((w) =>
            db.availabilityRule.create({
              data: {
                astrologerId: profile.id,
                dayOfWeek: day,
                startTime: w.startTime,
                endTime: w.endTime,
              },
            })
          )
        );
      }
      if (kept.length > 0) {
        await db.$transaction(
          kept.map((r) =>
            db.availabilityRule.update({
              where: { id: r.id },
              data: { dayOfWeek: day, startTime: r.startTime, endTime: r.endTime },
            })
          )
        );
      }
      const toDelete = existing.filter((r) => !matches.has(r.id));
      if (toDelete.length > 0) {
        await db.availabilityRule.deleteMany({
          where: { id: { in: toDelete.map((r) => r.id) } },
        });
      }
    }

    const rules = await db.availabilityRule.findMany({
      where: { astrologerId: profile.id },
      orderBy: { dayOfWeek: "asc" },
    });
    return res.json({ rules });
  } catch (err) {
    console.error("Bulk availability rules error:", err);
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

      const dayOfWeek =
        (parsed.data.dayOfWeek as number | undefined) ?? existing.dayOfWeek;
      const newStart = (parsed.data.startTime
        ? new Date(`1970-01-01T${parsed.data.startTime}`)
        : existing.startTime) as Date;
      const newEnd = (parsed.data.endTime
        ? new Date(`1970-01-01T${parsed.data.endTime}`)
        : existing.endTime) as Date;

      const others = await db.availabilityRule.findMany({
        where: { astrologerId: profile.id, dayOfWeek, id: { not: existing.id } },
        select: { startTime: true, endTime: true },
      });
      if (
        others.some((r) =>
          windowsOverlap(
            timeToMinutes(newStart),
            timeToMinutes(newEnd),
            timeToMinutes(r.startTime),
            timeToMinutes(r.endTime)
          )
        )
      ) {
        return res
          .status(400)
          .json({ error: "Availability rule overlaps an existing rule for this day" });
      }

      const resolve = (req.body as { resolve?: unknown })?.resolve;
      const clashes = await findExceptionClashes(
        profile.id,
        dayOfWeek,
        timeToMinutes(newStart),
        timeToMinutes(newEnd)
      );
      if (clashes.length > 0) {
        if (resolve !== "remove-exceptions") {
          return res.status(409).json({
            error: "This availability clashes with an exception on that day",
            code: "EXCEPTION_CONFLICT",
            conflicts: clashes,
          });
        }
        await db.availabilityException.deleteMany({
          where: { id: { in: clashes.map((c) => c.exceptionId) } },
        });
      }

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
    const resolve = (req.body as { resolve?: unknown })?.resolve;

    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayOfWeek = dayStart.getUTCDay();
    const excStartMin = startTime ? hhmmToMinutes(startTime) : 0;
    const excEndMin = endTime ? hhmmToMinutes(endTime) : 24 * 60;
    const excStartAt = new Date(dayStart.getTime() + excStartMin * 60000);
    const excEndAt = new Date(dayStart.getTime() + excEndMin * 60000);

    // A booked slot can never be blocked/adjusted away: the client already owns it.
    const booked = await db.booking.findMany({
      where: {
        astrologerId: profile.id,
        status: { in: BOOKING_BLOCKING_STATUSES },
        startAt: { lt: excEndAt },
        endAt: { gt: excStartAt },
      },
      select: { id: true, startAt: true, endAt: true },
    });
    if (booked.length > 0) {
      return res.status(409).json({
        error:
          "This exception overlaps a session already booked by a client. Reschedule or cancel that booking first.",
        code: "BOOKING_CONFLICT",
        bookings: booked.map((b) => ({
          id: b.id,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
        })),
      });
    }

    const rules = await db.availabilityRule.findMany({
      where: { astrologerId: profile.id, dayOfWeek, isActive: true },
      select: { id: true, dayOfWeek: true, startTime: true, endTime: true },
    });
    const clashes: RuleConflict[] = rules
      .filter((r) =>
        windowsOverlap(
          excStartMin,
          excEndMin,
          timeToMinutes(r.startTime),
          timeToMinutes(r.endTime)
        )
      )
      .map((r) => ({
        ruleId: r.id,
        dayOfWeek: r.dayOfWeek,
        startTime: minutesToHhmm(timeToMinutes(r.startTime)),
        endTime: minutesToHhmm(timeToMinutes(r.endTime)),
      }));

    if (clashes.length > 0 && resolve !== "trim-rules") {
      return res.status(409).json({
        error: "This exception clashes with your availability",
        code: "RULE_CONFLICT",
        conflicts: clashes,
      });
    }

    const exception = await db.$transaction(async (tx) => {
      if (clashes.length > 0) {
        for (const clash of clashes) {
          const remaining = subtractWindow(
            hhmmToMinutes(clash.startTime),
            hhmmToMinutes(clash.endTime),
            excStartMin,
            excEndMin
          );
          if (remaining.length === 0) {
            await tx.availabilityRule.delete({ where: { id: clash.ruleId } });
            continue;
          }
          const first = remaining[0];
          if (!first) continue;
          const rest = remaining.slice(1);
          await tx.availabilityRule.update({
            where: { id: clash.ruleId },
            data: {
              startTime: new Date(`1970-01-01T${minutesToHhmm(first.start)}`),
              endTime: new Date(`1970-01-01T${minutesToHhmm(first.end)}`),
            },
          });
          for (const w of rest) {
            await tx.availabilityRule.create({
              data: {
                astrologerId: profile.id,
                dayOfWeek,
                startTime: new Date(`1970-01-01T${minutesToHhmm(w.start)}`),
                endTime: new Date(`1970-01-01T${minutesToHhmm(w.end)}`),
              },
            });
          }
        }
      }

      return tx.availabilityException.upsert({
        where: {
          astrologerId_date: {
            astrologerId: profile.id,
            date: new Date(`${date}T00:00:00`),
          },
        },
        create: {
          astrologerId: profile.id,
          date: new Date(`${date}T00:00:00`),
          isBlocked,
          startTime: startTime ? new Date(`1970-01-01T${startTime}`) : null,
          endTime: endTime ? new Date(`1970-01-01T${endTime}`) : null,
          reason,
        },
        update: {
          isBlocked,
          startTime: startTime ? new Date(`1970-01-01T${startTime}`) : null,
          endTime: endTime ? new Date(`1970-01-01T${endTime}`) : null,
          reason,
        },
      });
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
        id: true,
        slug: true,
        status: true,
        templateId: true,
        templateData: true,
        questionPricePaise: true,
        callPricePerSlotPaise: true,
        slotDurationMinutes: true,
        isAcceptingQuestions: true,
        isAcceptingBookings: true,
        allowCustomQuestions: true,
        user: { select: { name: true, username: true, profileImageUrl: true } },
      },
    });
    if (!profile) {
      return res.status(404).json({ error: "Astrologer not found" });
    }

    const { template, schema, site } = await buildSite(profile);
    return res.json({
      slug: profile.slug,
      astrologerId: profile.id,
      astrologerName: profile.user.name,
      templateId: template.id,
      templateName: template.name,
      templatePreviewImageUrl: template.previewImageUrl,
      schema,
      site,
      questionPricePaise: profile.questionPricePaise,
      callPricePerSlotPaise: profile.callPricePerSlotPaise,
      slotDurationMinutes: profile.slotDurationMinutes,
      isAcceptingQuestions: profile.isAcceptingQuestions,
      isAcceptingBookings: profile.isAcceptingBookings,
      allowCustomQuestions: profile.allowCustomQuestions,
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

    const openSlots = openSlotsForRules(
      profile,
      profile.availabilityRules,
      profile.availabilityExceptions,
      date
    );

    // Hide slots that a settled booking already owns. PendingPayment holds are
    // intentionally ignored so an abandoned checkout does not lock the slot.
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const booked = await db.booking.findMany({
      where: {
        astrologerId: profile.id,
        status: { in: [BookingStatus.Confirmed, BookingStatus.Rescheduled] },
        startAt: { lt: dayEnd },
        endAt: { gt: dayStart },
      },
      select: { startAt: true, endAt: true },
    });

    const slots = openSlots.filter(
      (slot) =>
        !booked.some(
          (b) =>
            b.startAt.getTime() < new Date(slot.endAt).getTime() &&
            b.endAt.getTime() > new Date(slot.startAt).getTime()
        )
    );

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
        allowCustomQuestions: true,
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
