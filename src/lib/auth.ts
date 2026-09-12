import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { db } from "../../prisma/db";

const ACCESS_SECRET = new TextEncoder().encode(
  process.env.JWT_ACCESS_SECRET || "dev-access-secret-change-me"
);
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-change-me";

const ACCESS_TOKEN_EXPIRY = "24h";
const REFRESH_TOKEN_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signAccessToken(
  userId: string,
  role: string,
  sessionId?: string
) {
  return new SignJWT({ sub: userId, role, ...(sessionId ? { sid: sessionId } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(ACCESS_SECRET);
}

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, ACCESS_SECRET);
  return payload;
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function storeRefreshToken(
  userId: string,
  token: string,
  userAgent?: string,
  ip?: string
) {
  const tokenHash = hashToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_DAYS);

  return db.refreshToken.create({
    data: {
      userId,
      tokenHash,
      userAgent,
      ip,
      expiresAt,
    },
  });
}

export async function revokeRefreshToken(tokenHash: string) {
  return db.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function validateRefreshToken(token: string) {
  const tokenHash = hashToken(token);
  const stored = await db.refreshToken.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  return stored;
}

/**
 * Single-active-session policy: revoke every active session for the user so a
 * fresh login on another device immediately invalidates all previous ones
 * (their access tokens fail the sid check in `requireAuth`).
 */
export async function revokeAllRefreshTokens(userId: string) {
  return db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** True when the session referenced by an access token's `sid` is still active. */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const session = await db.refreshToken.findUnique({ where: { id: sessionId } });
  return Boolean(
    session && session.revokedAt === null && session.expiresAt > new Date()
  );
}
