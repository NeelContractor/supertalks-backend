import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BookingStatus } from "@prisma/client";
import { db } from "../prisma/db";
import { api, cleanupUsers, createAstrologer, json, registerUser, testEmail, uniqueUsername } from "./helpers";

let astrologer: Awaited<ReturnType<typeof createAstrologer>>;
let clientToken = "";
let clientUserId = "";
let clientEmail = "";

/**
 * Times are relative to the wall clock on purpose: `upcoming` filters on
 * `startAt > now`, so hard-coded dates would silently rot as the suite ages.
 */
const HOUR = 3_600_000;

type SeedKey = "past" | "soonest" | "middle" | "latest" | "cancelled" | "pending" | "completed";

// Populated in beforeAll; the cast is what lets `ids.soonest` be a plain
// `string` at the assertion sites under noUncheckedIndexedAccess.
const ids = {} as Record<SeedKey, string>;

/** `offsetMs` is relative to now, so the past/future split is always honest. */
async function seed(key: SeedKey, offsetMs: number, status: BookingStatus) {
  const startAt = new Date(Date.now() + offsetMs);
  const row = await db.booking.create({
    data: {
      clientId: clientUserId,
      astrologerId: astrologer.profile.id,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60_000),
      status,
      pricePaise: 1000,
      createdAt: new Date(),
    },
  });
  ids[key] = row.id;
}

beforeAll(async () => {
  astrologer = await createAstrologer();
  clientEmail = testEmail("upcomingclient");
  const res = await registerUser({
    name: "Upcoming Client",
    email: clientEmail,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  const body = await json<{ accessToken: string; user: { id: string } }>(res);
  clientToken = body.accessToken;
  clientUserId = body.user.id;

  // Nearest-first expectation, seeded out of order on purpose.
  await seed("past", -3 * HOUR, BookingStatus.Confirmed);
  await seed("latest", 48 * HOUR, BookingStatus.Confirmed);
  await seed("middle", 5 * HOUR, BookingStatus.Rescheduled);
  await seed("soonest", 1 * HOUR, BookingStatus.Confirmed);
  await seed("cancelled", 2 * HOUR, BookingStatus.CancelledByClient);
  await seed("pending", 90 * 60_000, BookingStatus.PendingPayment);
  await seed("completed", 3 * HOUR, BookingStatus.Completed);
});

afterAll(async () => {
  await db.booking.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await cleanupUsers(astrologer.creds.email, clientEmail);
});

type Row = { id: string; startAt: string; status: string };

async function listUpcoming(query = "", token = clientToken, role = "client") {
  const qs = new URLSearchParams({ upcoming: "true", limit: "50", role });
  const res = await api("GET", `/bookings?${qs}${query}`, { token });
  expect(res.status).toBe(200);
  return json<{ bookings: Row[]; total: number; counts: Record<string, number> }>(res);
}

describe("GET /bookings?upcoming=true", () => {
  test("returns future Confirmed/Rescheduled nearest start first", async () => {
    const body = await listUpcoming();
    const mine = body.bookings.filter((b) => Object.values(ids).includes(b.id));
    expect(mine.map((b) => b.id)).toEqual([ids.soonest, ids.middle, ids.latest]);
    expect(body.total).toBe(mine.length);
  });

  test("excludes past, cancelled, pending-payment and completed sessions", async () => {
    const body = await listUpcoming();
    const returned = new Set(body.bookings.map((b) => b.id));
    expect(returned.has(ids.past)).toBe(false);
    expect(returned.has(ids.cancelled)).toBe(false);
    expect(returned.has(ids.pending)).toBe(false);
    expect(returned.has(ids.completed)).toBe(false);
  });

  test("ignores sort=latest, which would otherwise put the furthest first", async () => {
    const body = await listUpcoming("&sort=latest");
    const mine = body.bookings.filter((b) => Object.values(ids).includes(b.id));
    expect(mine.map((b) => b.id)).toEqual([ids.soonest, ids.middle, ids.latest]);
  });

  test("ignores a conflicting status filter", async () => {
    const body = await listUpcoming("&status=Completed");
    const mine = body.bookings.filter((b) => Object.values(ids).includes(b.id));
    expect(mine.map((b) => b.id)).toEqual([ids.soonest, ids.middle, ids.latest]);
  });

  test("honours limit on the nearest sessions", async () => {
    const res = await api("GET", "/bookings?upcoming=true&limit=1&role=client", { token: clientToken });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[] }>(res);
    const mine = body.bookings.filter((b) => Object.values(ids).includes(b.id));
    expect(mine.map((b) => b.id)).toEqual([ids.soonest]);
  });

  test("astrologer view returns the same schedule for the provider side", async () => {
    const body = await listUpcoming("", astrologer.accessToken, "astrologer");
    const mine = body.bookings.filter((b) => Object.values(ids).includes(b.id));
    expect(mine.map((b) => b.id)).toEqual([ids.soonest, ids.middle, ids.latest]);
  });

  test("tab counts are unaffected by the upcoming filter", async () => {
    const body = await listUpcoming();
    // Confirmed + Rescheduled across the whole scope, past rows included.
    expect(body.counts.Confirmed).toBeGreaterThanOrEqual(3);
    expect(body.counts.Completed).toBeGreaterThanOrEqual(1);
  });

  test("without upcoming the normal sorted list still works", async () => {
    const res = await api("GET", "/bookings?sort=oldest&limit=50&role=client", { token: clientToken });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[] }>(res);
    const mine = body.bookings.filter((b) => Object.values(ids).includes(b.id));
    // Every seeded status is back, including the past session that
    // `upcoming=true` filters out, ordered nearest start first.
    expect(mine).toHaveLength(Object.keys(ids).length);
    expect(new Set(mine.map((b) => b.id))).toEqual(new Set(Object.values(ids)));
    expect(mine.map((b) => Date.parse(b.startAt))).toEqual(
      [...mine.map((b) => Date.parse(b.startAt))].sort((a, b) => a - b),
    );
  });

  test("requires authentication", async () => {
    const res = await api("GET", "/bookings?upcoming=true");
    expect(res.status).toBe(401);
  });
});
