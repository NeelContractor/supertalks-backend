import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { sendValidationError } from "../lib/http";
import { UserRole } from "@prisma/client";

const router = Router();

const updateMeSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  mobile: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, e.g. +919876543210")
    .nullable()
    .optional(),
  profileImageUrl: z.string().url().nullable().optional(),
});

const meSelect = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  mobile: true,
  mobileVerified: true,
  username: true,
  profileImageUrl: true,
  role: true,
  createdAt: true,
} as const;

/**
 * @openapi
 * /me:
 *   get:
 *     tags: [Users]
 *     summary: Get the current user's own profile (works for any role)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/UserExtended' }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({
      where: { id: req.user!.id },
      select: meSelect,
    });
    if (!user) return res.status(401).json({ error: "User not found" });

    return res.json({ user });
  } catch (err) {
    console.error("Get me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /me/stats:
 *   get:
 *     tags: [Users]
 *     summary: Get dashboard stats for the current user (any role -
 *       astrologers see earnings, clients see their own activity)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         required: false
 *         schema:
 *           type: string
 *           enum: [client, astrologer]
 *     responses:
 *       200: { description: Stats }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.get("/me/stats", requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({
      where: { id: req.user!.id },
      select: { role: true },
    });
    if (!user) return res.status(401).json({ error: "User not found" });

    // `role` lets a user (e.g. an astrologer who also uses the product as a
    // customer) view stats from the other side. Defaults to their role.
    const { role } = req.query;
    const viewAs =
      role === "astrologer"
        ? UserRole.Astrologer
        : role === "client"
          ? UserRole.Client
          : user.role;

    const now = new Date();

    if (viewAs === UserRole.Astrologer) {
      const profile = await db.astrologerProfile.findUnique({
        where: { userId: req.user!.id },
        select: { id: true },
      });
      if (!profile) return res.status(403).json({ error: "User is not an astrologer" });
      const astrologerId = profile.id;

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
    }

    const clientId = req.user!.id;
    const [pendingQuestions, answeredQuestions, rejectedQuestions, totalQuestions, upcomingBookings, completedBookings, totalBookings] =
      await Promise.all([
        db.question.count({ where: { clientId, status: "Queued" } }),
        db.question.count({ where: { clientId, status: "Answered" } }),
        db.question.count({ where: { clientId, status: "Rejected" } }),
        db.question.count({ where: { clientId } }),
        db.booking.count({
          where: {
            clientId,
            status: { in: ["Confirmed", "Rescheduled"] },
            startAt: { gt: now },
          },
        }),
        db.booking.count({ where: { clientId, status: "Completed" } }),
        db.booking.count({ where: { clientId } }),
      ]);

    return res.json({
      pendingQuestions,
      answeredQuestions,
      rejectedQuestions,
      totalQuestions,
      upcomingBookings,
      completedBookings,
      totalBookings,
      totalEarningsPaise: 0,
    });
  } catch (err) {
    console.error("Get me stats error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /me:
 *   patch:
 *     tags: [Users]
 *     summary: Update the current user's profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 120 }
 *               mobile: { type: string, nullable: true, description: E.164 format }
 *               profileImageUrl: { type: string, format: uri, nullable: true }
 *     responses:
 *       200:
 *         description: Updated user profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/UserExtended' }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.patch("/me", requireAuth, async (req, res) => {
  try {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const data = parsed.data;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }

    const user = await db.user.update({
      where: { id: req.user!.id },
      data,
      select: meSelect,
    });

    return res.json({ user });
  } catch (err) {
    console.error("Update me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;