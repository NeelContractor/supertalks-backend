import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { db } from "../../prisma/db";

const ACCESS_SECRET = new TextEncoder().encode(
  process.env.JWT_ACCESS_SECRET || "dev-access-secret-change-me"
);
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-change-me";

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_DAYS = 7;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signAccessToken(userId: string, role: string) {
  return new SignJWT({ sub: userId, role })
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
