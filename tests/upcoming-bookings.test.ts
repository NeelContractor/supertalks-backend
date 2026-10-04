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
    // The Upcoming badge counts sessions still ahead of us, matching the tab.
    expect(body.counts.Confirmed).toBe(3);
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

/**
 * An unpaid booking is a checkout hold, not a session: it blocks no slot and is
 * never reverted when a checkout is abandoned, so the provider side must not
 * list or count it. The client keeps seeing theirs - that hold is what they
 * still have to pay.
 */
describe("GET /bookings (default list)", () => {
  test("hides unpaid holds from the astrologer", async () => {
    const res = await api("GET", "/bookings?limit=50&role=astrologer", {
      token: astrologer.accessToken,
    });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[]; counts: Record<string, number> }>(res);
    const mine = body.bookings.filter((b) => Object.values(ids).includes(b.id));
    expect(mine.map((b) => b.id)).not.toContain(ids.pending);
    expect(mine).toHaveLength(Object.keys(ids).length - 1);
  });

  test("tab counts match the rows the astrologer can actually see", async () => {
    const res = await api("GET", "/bookings?limit=50&role=astrologer", {
      token: astrologer.accessToken,
    });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[]; counts: Record<string, number> }>(res);
    expect(body.counts.Pending).toBe(0);
    // Fresh astrologer: every row here belongs to this file's seeds.
    expect(body.counts.all).toBe(body.bookings.length);
  });

  test("an explicit status filter still reaches the astrologer's unpaid holds", async () => {
    const res = await api("GET", "/bookings?status=PendingPayment&role=astrologer", {
      token: astrologer.accessToken,
    });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[] }>(res);
    expect(body.bookings.map((b) => b.id)).toContain(ids.pending);
  });

  test("the client still sees the hold they have to pay", async () => {
    const res = await api("GET", "/bookings?limit=50&role=client", { token: clientToken });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[]; counts: Record<string, number> }>(res);
    expect(body.bookings.map((b) => b.id)).toContain(ids.pending);
    expect(body.counts.Pending).toBe(1);
  });

  test("astrologer stats leave unpaid holds out of the lifetime total", async () => {
    const res = await api("GET", "/astrologers/me/stats", { token: astrologer.accessToken });
    expect(res.status).toBe(200);
    const stats = await json<{ totalBookings: number }>(res);
    const list = await api("GET", "/bookings?limit=100&role=astrologer", {
      token: astrologer.accessToken,
    });
    const body = await json<{ bookings: Row[] }>(list);
    expect(stats.totalBookings).toBe(body.bookings.length);
  });
});

describe("GET /bookings?status=Confirmed (Upcoming tab)", () => {
  async function listConfirmed(query = "", role = "client", token = clientToken) {
    const qs = new URLSearchParams({ status: "Confirmed", limit: "50", role });
    const res = await api("GET", `/bookings?${qs}${query}`, { token });
    expect(res.status).toBe(200);
    return json<{ bookings: Row[]; total: number; counts: Record<string, number> }>(res);
  }

  test("omits a Confirmed booking whose start time has passed", async () => {
    const body = await listConfirmed();
    const returned = new Set(body.bookings.map((b) => b.id));
    expect(returned.has(ids.past)).toBe(false);
    expect(returned.has(ids.soonest)).toBe(true);
    expect(returned.has(ids.latest)).toBe(true);
  });

  test("keeps the passed session in the unfiltered list", async () => {
    const res = await api("GET", "/bookings?limit=50&role=client", { token: clientToken });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[] }>(res);
    expect(new Set(body.bookings.map((b) => b.id))).toEqual(new Set(Object.values(ids)));
  });

  test("the badge counts future Confirmed and Rescheduled sessions only", async () => {
    const body = await listConfirmed();
    // The tab covers Confirmed + Rescheduled, so the badge is the future rows of
    // both (soonest, middle=Rescheduled, latest) while this narrower query only
    // returns the Confirmed ones. It must never be lower than the list.
    expect(body.counts.Confirmed).toBe(3);
    expect(body.counts.Confirmed).toBeGreaterThanOrEqual(body.total);
  });

  test("applies to the astrologer view too", async () => {
    const body = await listConfirmed("", "astrologer", astrologer.accessToken);
    const returned = new Set(body.bookings.map((b) => b.id));
    expect(returned.has(ids.past)).toBe(false);
    expect(returned.has(ids.soonest)).toBe(true);
  });

  test("other status tabs are untouched", async () => {
    const res = await api("GET", "/bookings?status=Completed&limit=50&role=client", {
      token: clientToken,
    });
    expect(res.status).toBe(200);
    const body = await json<{ bookings: Row[] }>(res);
    expect(body.bookings.map((b) => b.id)).toEqual([ids.completed]);
  });
});
