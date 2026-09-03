import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  mobile: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, e.g. +919876543210").optional(),
  username: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9_]{3,30}$/, "3-30 chars: lowercase letters, numbers, underscore"),
  password: z.string().min(8).max(72)
    .regex(/[A-Z]/, "At least one uppercase letter")
    .regex(/[0-9]/, "At least one number"),
  profileImageUrl: z.string().url().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  // allow login via email OR username
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
});

export const googleAuthSchema = z.object({
  idToken: z.string().min(20),   // Google ID token from the client SDK
  // client tells the server whether this is a signup-as-astrologer flow
  intendedRole: z.enum(["client", "astrologer"]).default("client"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});