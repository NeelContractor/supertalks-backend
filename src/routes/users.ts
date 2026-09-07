import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { sendValidationError } from "../lib/http";

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