import { Router } from "express";
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
} from "../lib/auth";
import { sendValidationError } from "../lib/http";
import { registerSchema, loginSchema } from "../types/auth";

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
 *     responses:
 *       201:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
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

    const user = await db.user.create({
      data: {
        name: data.name,
        email: data.email,
        mobile: data.mobile,
        username: data.username,
        profileImageUrl: data.profileImageUrl,
        passwordHash,
      },
      select: { id: true, name: true, email: true, username: true, role: true },
    });

    const refreshToken = generateRefreshToken();
    const session = await storeRefreshToken(
      user.id,
      refreshToken,
      req.headers["user-agent"],
      req.ip
    );

    const accessToken = await signAccessToken(user.id, user.role, session.id);

    return res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) {
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
