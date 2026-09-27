import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { db } from "../prisma/db";
import { api, createAstrologer, json, registerUser, testEmail, uniqueUsername } from "./helpers";

let astrologer: Awaited<ReturnType<typeof createAstrologer>>;
let clientId = "";
let clientToken = "";
let clientEmail = "";

// Fixed, widely-spaced timestamps so ordering assertions can't be affected by
// two rows sharing a createdAt/startAt value.
const T0 = new Date("2026-01-05T10:00:00.000Z");
const T1 = new Date("2026-02-10T10:00:00.000Z");
const T2 = new Date("2026-03-15T10:00:00.000Z");

beforeAll(async () => {
  astrologer = await createAstrologer();
  clientEmail = testEmail("sortclient");
  const res = await registerUser({
    name: "Sort Client",
    email: clientEmail,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  const body = await json<{ accessToken: string; user: { id: string } }>(res);
  clientToken = body.accessToken;
  clientId = body.user.id;
});

afterAll(async () => {
  await removeUser(db, clientEmail);
});

async function removeUser(dbClient: PrismaClient, email: string) {
  const user = await dbClient.user.findUnique({ where: { email } });
  if (!user) return;
  const profile = await dbClient.astrologerProfile.findUnique({ where: { userId: user.id } });
  if (profile) {
    await dbClient.questionMessage.deleteMany({ where: { question: { astrologerId: profile.id } } });
    await dbClient.question.deleteMany({ where: { astrologerId: profile.id } });
  }
  await dbClient.questionMessage.deleteMany({ where: { question: { clientId: user.id } } });
  await dbClient.question.deleteMany({ where: { clientId: user.id } });
  await dbClient.booking.deleteMany({ where: { clientId: user.id } });
  await dbClient.payment.deleteMany({ where: { payerId: user.id } });
  await dbClient.refreshToken.deleteMany({ where: { userId: user.id } });
  await dbClient.astrologerProfile.deleteMany({ where: { userId: user.id } });
  await dbClient.user.delete({ where: { id: user.id } });
}

/** Three questions created oldest -> newest. */
async function seedQuestions(): Promise<[string, string, string]> {
  const make = (i: number, at: Date) =>
    db.question
      .create({
        data: {
          clientId,
          astrologerId: astrologer.profile.id,
          questionText: `Sort probe question number ${i} with enough characters`,
          category: "Sorting",
          pricePaise: 1000,
          createdAt: at,
        },
      })
      .then((row) => row.id);

  return [await make(1, T0), await make(2, T1), await make(3, T2)];
}

/** Three bookings with startAt oldest -> newest. */
async function seedBookings(): Promise<[string, string, string]> {
  const make = (i: number, at: Date) =>
    db.booking
      .create({
        data: {
          clientId,
          astrologerId: astrologer.profile.id,
          startAt: at,
          endAt: new Date(at.getTime() + 30 * 60 * 1000),
          pricePaise: 1000,
          createdAt: at,
          clientNote: `Sort probe booking ${i}`,
        },
      })
      .then((row) => row.id);

  return [await make(1, T0), await make(2, T1), await make(3, T2)];
}

async function listQuestions(sort?: string) {
  const qs = new URLSearchParams({ limit: "50" });
  if (sort) qs.set("sort", sort);
  const res = await api("GET", `/questions?${qs}`, { token: clientToken });
  expect(res.status).toBe(200);
  return json<{ questions: { id: string; createdAt: string }[] }>(res);
}

async function listBookings(sort?: string) {
  const qs = new URLSearchParams({ limit: "50" });
  if (sort) qs.set("sort", sort);
  const res = await api("GET", `/bookings?${qs}`, { token: clientToken });
  expect(res.status).toBe(200);
  return json<{ bookings: { id: string; startAt: string }[] }>(res);
}

/** Reduce the full list down to just the ids this test seeded, keeping order. */
function pick<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const wanted = new Set(ids);
  return rows.filter((r) => wanted.has(r.id));
}

describe("list sort order", () => {
  describe("questions", () => {
    let ids: [string, string, string];

    beforeAll(async () => {
      ids = await seedQuestions();
    });

    afterAll(async () => {
      await db.question.deleteMany({ where: { id: { in: ids } } });
    });

    test("sort=latest returns newest first", async () => {
      const body = await listQuestions("latest");
      const mine = pick(body.questions, ids);
      expect(mine.map((q) => q.id)).toEqual([ids[2], ids[1], ids[0]]);
    });

    test("sort=oldest returns oldest first", async () => {
      const body = await listQuestions("oldest");
      const mine = pick(body.questions, ids);
      expect(mine.map((q) => q.id)).toEqual([ids[0], ids[1], ids[2]]);
    });

    test("omitting sort keeps the latest-first default", async () => {
      const body = await listQuestions();
      const mine = pick(body.questions, ids);
      expect(mine.map((q) => q.id)).toEqual([ids[2], ids[1], ids[0]]);
    });

    test("an unknown sort value falls back to latest", async () => {
      const body = await listQuestions("sideways");
      const mine = pick(body.questions, ids);
      expect(mine.map((q) => q.id)).toEqual([ids[2], ids[1], ids[0]]);
    });

    test("sorting is applied alongside a status filter", async () => {
      const filtered = await api("GET", "/questions?status=PendingPayment&sort=oldest&limit=50", {
        token: clientToken,
      });
      expect(filtered.status).toBe(200);
      const body = await json<{ questions: { id: string }[] }>(filtered);
      const mine = pick(body.questions, ids);
      expect(mine).toHaveLength(3);
      expect(mine.map((q) => q.id)).toEqual([ids[0], ids[1], ids[2]]);
    });
  });

  describe("bookings", () => {
    let ids: [string, string, string];

    beforeAll(async () => {
      ids = await seedBookings();
    });

    afterAll(async () => {
      await db.booking.deleteMany({ where: { id: { in: ids } } });
    });

    test("sort=latest returns the latest session start first", async () => {
      const body = await listBookings("latest");
      const mine = pick(body.bookings, ids);
      expect(mine.map((b) => b.id)).toEqual([ids[2], ids[1], ids[0]]);
    });

    test("sort=oldest returns the earliest session start first", async () => {
      const body = await listBookings("oldest");
      const mine = pick(body.bookings, ids);
      expect(mine.map((b) => b.id)).toEqual([ids[0], ids[1], ids[2]]);
    });

    test("omitting sort keeps the latest-first default", async () => {
      const body = await listBookings();
      const mine = pick(body.bookings, ids);
      expect(mine.map((b) => b.id)).toEqual([ids[2], ids[1], ids[0]]);
    });
  });
});
