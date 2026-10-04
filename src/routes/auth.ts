import { Router } from "express";
import { UserRole } from "@prisma/client";
import { db } from "../../prisma/db";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  revokeRefreshToken,
  hashToken,
  validateRefreshToken,
  revokeAllRefreshTokens,
  createAuthHandoff,
  consumeAuthHandoff,
} from "../lib/auth";
import {
  isUniqueConstraintError,
  runWithUniqueSlug,
  uniqueConstraintField,
} from "../lib/unique-slug";
import { sendValidationError } from "../lib/http";
import { requireAuth } from "../lib/middleware";
import { registerSchema, loginSchema, handoffExchangeSchema } from "../types/auth";

const router = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, username, password]
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 120 }
 *               email: { type: string, format: email }
 *               mobile: { type: string, nullable: true, description: E.164 format }
 *               username: { type: string, pattern: '^[a-z0-9_]{3,30}$' }
 *               password: { type: string, minLength: 8, maxLength: 72 }
 *               profileImageUrl: { type: string, format: uri, nullable: true }
 *               role: { type: string, enum: [client, astrologer], default: client }
 *     responses:
 *       201:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 profile: { $ref: '#/components/schemas/AstrologerProfile', nullable: true }
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *       400: { description: Validation error }
 *       409: { description: Email or username already taken }
 *       500: { description: Internal server error }
 */
router.post("/register", async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendValidationError(res, parsed.error);
    }

    const data = parsed.data;

    const existing = await db.user.findFirst({
      where: { OR: [{ email: data.email }, { username: data.username }] },
      select: { email: true, username: true },
    });

    if (existing) {
      const field = existing.email === data.email ? "email" : "username";
      return res.status(409).json({ error: `${field} already taken` });
    }

    const passwordHash = await hashPassword(data.password);
    const wantsAstrologer = data.role === "astrologer";

    // Astrologer signups are created with their role and an (unreviewed,
    // Pending) profile right away so the rest of the app can treat them as a
    // provider immediately. The 7-step /register application is submitted
    // separately and is what actually gates approval.
    //
    // The profile slug is the astrologer's public identity and is
    // unique-indexed, so a collision retries with a fresh one instead of
    // failing the signup.
    const { user, profile } = await runWithUniqueSlug((slug) =>
      db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: data.name,
            email: data.email,
            mobile: data.mobile,
            username: data.username,
            profileImageUrl: data.profileImageUrl,
            passwordHash,
            role: wantsAstrologer ? UserRole.Astrologer : UserRole.Client,
          },
          select: { id: true, name: true, email: true, username: true, role: true },
        });

        if (!wantsAstrologer) return { user: created, profile: null };

        const createdProfile = await tx.astrologerProfile.create({
          data: { userId: created.id, slug, timezone: "Asia/Kolkata" },
        });

        return { user: created, profile: createdProfile };
      }),
    );

    const refreshToken = generateRefreshToken();
    const session = await storeRefreshToken(
      user.id,
      refreshToken,
      req.headers["user-agent"],
      req.ip
    );

    const accessToken = await signAccessToken(user.id, user.role, session.id);

    return res.status(201).json({ user, profile, accessToken, refreshToken });
  } catch (err) {
    // The pre-check above cannot see a signup that commits a microsecond later,
    // so the unique index is the real arbiter. Losing that race must read as the
    // same 409 the pre-check produces, not as a server error.
    if (isUniqueConstraintError(err)) {
      const field = uniqueConstraintField(err);
      const label =
        field === "username" || field === "email" ? field : "email or username";
      return res.status(409).json({ error: `${label} already taken` });
    }
    console.error("Register error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /auth/signin:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in with email or username
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identifier, password]
 *             properties:
 *               identifier: { type: string, minLength: 3, description: Email or username }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Signed in
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *       400: { description: Validation error }
 *       401: { description: Invalid credentials }
 *       403: { description: Account deactivated }
 *       500: { description: Internal server error }
 */
router.post("/signin", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendValidationError(res, parsed.error);
    }

    const { identifier, password } = parsed.data;

    const user = await db.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] },
      select: {
        id: true,
        name: true,
        email: true,
        username: true,
        role: true,
        passwordHash: true,
        isActive: true,
      },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Single active session: a new login on any device revokes every other
    // session for this account, immediately expiring the other device.
    await revokeAllRefreshTokens(user.id);

    const refreshToken = generateRefreshToken();
    const session = await storeRefreshToken(
      user.id,
      refreshToken,
      req.headers["user-agent"],
      req.ip
    );

    const accessToken = await signAccessToken(user.id, user.role, session.id);
    const { passwordHash: _, ...safeUser } = user;

    return res.json({ user: safeUser, accessToken, refreshToken });
  } catch (err) {
    console.error("Signin error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate a refresh token into a fresh access/refresh pair
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *       400: { description: Missing refreshToken }
 *       401: { description: Invalid or expired refresh token }
 *       403: { description: Account deactivated }
 *       500: { description: Internal server error }
 */
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== "string") {
      return res.status(400).json({ error: "refreshToken is required" });
    }

    const stored = await validateRefreshToken(refreshToken);
    if (!stored) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    const user = await db.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, role: true, isActive: true },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    // Rotate: revoke the old refresh token and issue a fresh pair. This keeps
    // the current device's session alive without touching sibling sessions.
    await revokeRefreshToken(stored.tokenHash);

    const newRefreshToken = generateRefreshToken();
    const session = await storeRefreshToken(
      user.id,
      newRefreshToken,
      req.headers["user-agent"],
      req.ip
    );

    const accessToken = await signAccessToken(user.id, user.role, session.id);

    return res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error("Refresh error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /auth/handoff:
 *   post:
 *     tags: [Auth]
 *     summary: Mint a one-time code so another app can adopt this session
 *     description: >
 *       The public astrologer site calls this while signed in, then redirects
 *       the client to the dashboard app with the code in the URL. Only the hash
 *       is stored server-side and the code expires after 60 seconds.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Handoff code minted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: string }
 *                 expiresAt: { type: string, format: date-time }
 *       401: { description: Missing or invalid token }
 */
router.post("/handoff", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { code, expiresAt } = await createAuthHandoff(userId);
    return res.json({ code, expiresAt });
  } catch (err) {
    console.error("Handoff mint error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /auth/handoff/exchange:
 *   post:
 *     tags: [Auth]
 *     summary: Redeem a handoff code for a fresh token pair
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string }
 *     responses:
 *       200:
 *         description: New token pair issued for the handoff user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *       400: { description: Missing code }
 *       401: { description: Invalid, expired, or already-used code }
 *       403: { description: Account deactivated }
 *       500: { description: Internal server error }
 */
router.post("/handoff/exchange", async (req, res) => {
  try {
    const parsed = handoffExchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendValidationError(res, parsed.error);
    }

    const handoff = await consumeAuthHandoff(parsed.data.code);
    if (!handoff) {
      return res.status(401).json({ error: "Invalid, expired, or already-used handoff code" });
    }

    const user = await db.user.findUnique({
      where: { id: handoff.userId },
      select: {
        id: true,
        name: true,
        email: true,
        username: true,
        role: true,
        isActive: true,
      },
    });
    if (!user || !user.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    // Matches sign-in: fresh single session for the receiving app, revoking a
    // same-account session elsewhere (the app's single-active-session policy).
    await revokeAllRefreshTokens(user.id);

    const refreshToken = generateRefreshToken();
    const session = await storeRefreshToken(
      user.id,
      refreshToken,
      req.headers["user-agent"],
      req.ip
    );

    const accessToken = await signAccessToken(user.id, user.role, session.id);

    return res.json({ user, accessToken, refreshToken });
  } catch (err) {
    console.error("Handoff exchange error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /auth/signout:
 *   post:
 *     tags: [Auth]
 *     summary: Sign out by revoking a refresh token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: Signed out
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400: { description: Missing refreshToken }
 *       500: { description: Internal server error }
 */
router.post("/signout", async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== "string") {
      return res.status(400).json({ error: "refreshToken is required" });
    }

    const tokenHash = hashToken(refreshToken);
    await revokeRefreshToken(tokenHash);

    return res.json({ message: "Signed out" });
  } catch (err) {
    console.error("Signout error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
