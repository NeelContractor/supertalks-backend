import { app } from "../src/app";
import { db } from "../prisma/db";
import { UserRole } from "@prisma/client";
import { randomUUID, randomBytes } from "crypto";

const server = app.listen(0);
const base = `http://localhost:${(server.address() as { port: number }).port}`;

export function getBaseUrl() {
  return base;
}

export function testEmail(prefix = "test") {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

export function uniqueUsername() {
  return `u_${randomBytes(4).toString("hex")}`;
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function registerUser(body: {
  name: string;
  email: string;
  username: string;
  password: string;
}) {
  return fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function signinUser(identifier: string, password: string) {
  return fetch(`${base}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
}

export async function api(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { token?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  return fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export async function createAstrologer(overrides: {
  name?: string;
  email?: string;
  username?: string;
  password?: string;
} = {}) {
  const creds = {
    name: overrides.name ?? "Test Astrologer",
    email: overrides.email ?? testEmail("astro"),
    username: overrides.username ?? uniqueUsername(),
    password: overrides.password ?? "AstroPass1",
  };

  const res = await registerUser(creds);
  const body = await json<{ accessToken: string }>(res);

  // Promote to astrologer + create profile (simulates onboarding)
  const user = await db.user.update({
    where: { email: creds.email },
    data: { role: UserRole.Astrologer },
  });

  const profile = await db.astrologerProfile.create({
    data: {
      userId: user.id,
      slug: `astro-${randomBytes(4).toString("hex")}`,
      timezone: "Asia/Kolkata",
    },
  });

  return {
    creds,
    user,
    profile,
    accessToken: body.accessToken as string,
  };
}

export async function cleanupUsers(...emails: string[]) {
  for (const email of emails) {
    if (!email) continue;
    const user = await db.user.findUnique({ where: { email } });
    if (!user) continue;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId: user.id },
    });
    if (profile) {
      await db.booking.deleteMany({ where: { astrologerId: profile.id } });
      await db.question.deleteMany({ where: { astrologerId: profile.id } });
      await db.availabilityRule.deleteMany({ where: { astrologerId: profile.id } });
      await db.availabilityException.deleteMany({ where: { astrologerId: profile.id } });
    }
    await db.booking.deleteMany({ where: { clientId: user.id } });
    await db.question.deleteMany({ where: { clientId: user.id } });
    await db.astrologerProfile.deleteMany({ where: { userId: user.id } });
    await db.refreshToken.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
}

export async function closeServer() {
  server.close();
}
