import { test, expect, afterAll, beforeAll } from "bun:test";
import {
  createAstrologer,
  api,
  registerUser,
  testEmail,
  uniqueUsername,
  cleanupUsers,
  getBaseUrl,
  json,
} from "./helpers";

interface Rule {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}
interface RulesBody {
  rules: Rule[];
}
interface Exception {
  id: string;
  date: string;
}
interface ExceptionsBody {
  exceptions: Exception[];
}
interface ErrorBody {
  error: string;
  code?: string;
  conflicts?: { ruleId?: string; exceptionId?: string }[];
  bookings?: unknown[];
}
interface SlotsBody {
  slots: { startAt: string; endAt: string }[];
}
interface BookingBody {
  booking: { id: string; status: string };
}

function hm(iso: string) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Date (YYYY-MM-DD) of the next occurrence of `day`, strictly in the future. */
function nextWeekday(day: number) {
  const now = new Date();
  const dist = (day - now.getUTCDay() + 7) % 7 || 7;
  const d = new Date(now);
  d.setUTCDate(now.getUTCDate() + dist);
  return d.toISOString().slice(0, 10);
}

let astro: Awaited<ReturnType<typeof createAstrologer>>;
let bookingAstro: Awaited<ReturnType<typeof createAstrologer>>;
let clientEmail = "";
let clientToken = "";
let monday = "";
let wednesday = "";
let thursday = "";

beforeAll(async () => {
  astro = await createAstrologer();
  bookingAstro = await createAstrologer();

  monday = nextWeekday(1);
  wednesday = nextWeekday(3);
  thursday = nextWeekday(4);

  // astro: Monday 09:00-17:00 availability
  await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });

  // bookingAstro: free bookings on Monday 09:00-17:00
  await api("PATCH", "/astrologers/me/pricing", {
    token: bookingAstro.accessToken,
    body: {
      questionPricePaise: 0,
      callPricePerSlotPaise: 0,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });
  await api("POST", "/astrologers/me/availability-rules", {
    token: bookingAstro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });

  clientEmail = testEmail("clash-client");
  const res = await registerUser({
    name: "Clash Client",
    email: clientEmail,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  clientToken = (await json<{ accessToken: string }>(res)).accessToken;
});

afterAll(async () => {
  await cleanupUsers(astro.creds.email, bookingAstro.creds.email, clientEmail);
});

test("an exception overlapping availability is rejected with RULE_CONFLICT", async () => {
  const res = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: { date: monday, isBlocked: false, startTime: "10:00", endTime: "12:00" },
  });
  expect(res.status).toBe(409);
  const body = await json<ErrorBody>(res);
  expect(body.code).toBe("RULE_CONFLICT");
  expect(body.conflicts?.length).toBeGreaterThan(0);
});

test("resolving with trim-rules splits the rule and saves the exception", async () => {
  const res = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: {
      date: monday,
      isBlocked: false,
      startTime: "10:00",
      endTime: "12:00",
      resolve: "trim-rules",
    },
  });
  expect(res.status).toBe(201);

  const list = await api("GET", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
  });
  const body = await json<RulesBody>(list);
  const mondayRules = body.rules.filter((r) => r.dayOfWeek === 1).map((r) => `${hm(r.startTime)}-${hm(r.endTime)}`);
  expect(mondayRules.sort()).toEqual(["09:00-10:00", "12:00-17:00"]);

  const exceptions = await api("GET", "/astrologers/me/exceptions", {
    token: astro.accessToken,
  });
  const excBody = await json<ExceptionsBody>(exceptions);
  expect(excBody.exceptions.some((e) => e.date.slice(0, 10) === monday)).toBe(true);
});

test("an exception that fully covers a rule removes that rule", async () => {
  await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 4, startTime: "09:00", endTime: "10:00" },
  });

  const res = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: {
      date: thursday,
      isBlocked: false,
      startTime: "08:00",
      endTime: "11:00",
      resolve: "trim-rules",
    },
  });
  expect(res.status).toBe(201);

  const list = await api("GET", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
  });
  const body = await json<RulesBody>(list);
  expect(body.rules.filter((r) => r.dayOfWeek === 4)).toHaveLength(0);
});

test("a rule overlapping a future exception is rejected with EXCEPTION_CONFLICT", async () => {
  const created = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: { date: wednesday, isBlocked: false, startTime: "10:00", endTime: "11:00" },
  });
  expect(created.status).toBe(201);

  const res = await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 3, startTime: "09:00", endTime: "12:00" },
  });
  expect(res.status).toBe(409);
  const body = await json<ErrorBody>(res);
  expect(body.code).toBe("EXCEPTION_CONFLICT");
  expect(body.conflicts?.length).toBeGreaterThan(0);
});

test("resolving with remove-exceptions deletes the exception and adds the rule", async () => {
  const res = await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 3, startTime: "09:00", endTime: "12:00", resolve: "remove-exceptions" },
  });
  expect(res.status).toBe(201);

  const exceptions = await api("GET", "/astrologers/me/exceptions", {
    token: astro.accessToken,
  });
  const excBody = await json<ExceptionsBody>(exceptions);
  expect(excBody.exceptions.some((e) => e.date.slice(0, 10) === wednesday)).toBe(false);

  const rules = await api("GET", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
  });
  const rulesBody = await json<RulesBody>(rules);
  expect(rulesBody.rules.some((r) => r.dayOfWeek === 3)).toBe(true);
});

test("an exception overlapping a booked slot is rejected with BOOKING_CONFLICT", async () => {
  const slotsRes = await api("GET", `/astrologers/${bookingAstro.profile.slug}/slots?date=${monday}`);
  const slotsBody = await json<SlotsBody>(slotsRes);
  const first = slotsBody.slots[0];
  if (!first) throw new Error("Expected at least one open slot");

  const bookingRes = await fetch(`${getBaseUrl()}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "clash-booking-1",
      Authorization: `Bearer ${clientToken}`,
    },
    body: JSON.stringify({ astrologerId: bookingAstro.profile.id, startAt: first.startAt }),
  });
  expect(bookingRes.status).toBe(201);
  const bookingBody = await json<BookingBody>(bookingRes);
  expect(bookingBody.booking.status).toBe("Confirmed");

  const res = await api("POST", "/astrologers/me/exceptions", {
    token: bookingAstro.accessToken,
    body: { date: monday, isBlocked: true, reason: "Day off" },
  });
  expect(res.status).toBe(409);
  const body = await json<ErrorBody>(res);
  expect(body.code).toBe("BOOKING_CONFLICT");
  expect(body.bookings?.length).toBeGreaterThan(0);

  const exceptions = await api("GET", "/astrologers/me/exceptions", {
    token: bookingAstro.accessToken,
  });
  const excBody = await json<ExceptionsBody>(exceptions);
  expect(excBody.exceptions.some((e) => e.date.slice(0, 10) === monday)).toBe(false);
});
