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
import { signAccessToken } from "../src/lib/auth";

interface MeBody {
  user: { id: string; name: string; role: string };
}
interface SlotsBody {
  slots: { startAt: string; endAt: string }[];
}
interface BookingBody {
  booking: { id: string; clientId: string; status: string };
}
interface QuestionBody {
  question: { id: string; clientId: string; status: string };
}
interface ListBody {
  bookings?: unknown[];
  questions?: unknown[];
}

let astro: Awaited<ReturnType<typeof createAstrologer>>;
let monday: string;
let client = { email: "", username: "", accessToken: "" as string };
const password = "ClientPass1";

beforeAll(async () => {
  astro = await createAstrologer();

  await api("PATCH", "/astrologers/me/pricing", {
    token: astro.accessToken,
    body: {
      questionPricePaise: 4900,
      callPricePerSlotPaise: 9900,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });

  await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });

  const now = new Date();
  const distToMonday = (1 - now.getUTCDay() + 7) % 7;
  const m = new Date(now);
  m.setUTCDate(now.getUTCDate() + distToMonday);
  monday = m.toISOString().slice(0, 10);

  client.email = testEmail("client");
  client.username = uniqueUsername();
  const res = await registerUser({
    name: "Shop Client",
    email: client.email,
    username: client.username,
    password,
  });
  client.accessToken = (await json<{ accessToken: string }>(res)).accessToken;
});

afterAll(async () => {
  await cleanupUsers(astro.creds.email, client.email);
});

test("GET /me returns the client's own profile", async () => {
  const res = await api("GET", "/me", { token: client.accessToken });
  expect(res.status).toBe(200);
  const body = await json<MeBody>(res);
  expect(body.user.id).toBeDefined();
  expect(body.user.role).toBe("Client");
});

test("PATCH /me updates own profile", async () => {
  const res = await api("PATCH", "/me", {
    token: client.accessToken,
    body: { name: "Renamed Client" },
  });
  expect(res.status).toBe(200);
  const body = await json<MeBody>(res);
  expect(body.user.name).toBe("Renamed Client");
});

test("client can book an open slot returned by /astrologers/:slug/slots", async () => {
  const slotsRes = await api("GET", `/astrologers/${astro.profile.slug}/slots?date=${monday}`);
  expect(slotsRes.status).toBe(200);
  const slotsBody = await json<SlotsBody>(slotsRes);
  expect(slotsBody.slots.length).toBeGreaterThan(0);
  const firstSlot = slotsBody.slots[0];
  if (!firstSlot) throw new Error("Expected at least one open slot");

  const res = await fetch(`${getBaseUrl()}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "test-booking-1",
      Authorization: `Bearer ${client.accessToken}`,
    },
    body: JSON.stringify({
      astrologerId: astro.profile.id,
      startAt: firstSlot.startAt,
    }),
  });
  expect(res.status).toBe(201);
  const body = await json<BookingBody>(res);
  expect(body.booking.clientId).toBeDefined();
  expect(body.booking.status).toBe("PendingPayment");
});

test("client booking of an off-schedule time is rejected with 409", async () => {
  const res = await fetch(`${getBaseUrl()}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "test-booking-2",
      Authorization: `Bearer ${client.accessToken}`,
    },
    body: JSON.stringify({
      astrologerId: astro.profile.id,
      startAt: `${monday}T12:34:00.000Z`,
    }),
  });
  expect(res.status).toBe(409);
});

test("non-client cannot create a booking", async () => {
  const astroToken = await signAccessToken(astro.user.id, "Astrologer");
  const res = await fetch(`${getBaseUrl()}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "test-booking-3",
      Authorization: `Bearer ${astroToken}`,
    },
    body: JSON.stringify({
      astrologerId: astro.profile.id,
      startAt: `${monday}T09:00:00.000Z`,
    }),
  });
  expect(res.status).toBe(403);
});

test("client can ask a question", async () => {
  const res = await api("POST", "/questions", {
    token: client.accessToken,
    body: {
      astrologerId: astro.profile.id,
      questionText: "Will my career improve this quarter?",
      category: "Career",
    },
  });
  expect(res.status).toBe(201);
  const body = await json<QuestionBody>(res);
  expect(body.question.status).toBe("PendingPayment");
});

test("client lists own bookings and questions", async () => {
  const bookings = await api("GET", "/bookings", { token: client.accessToken });
  expect(bookings.status).toBe(200);
  const bBody = await json<ListBody>(bookings);
  expect(Array.isArray(bBody.bookings)).toBe(true);

  const questions = await api("GET", "/questions", { token: client.accessToken });
  expect(questions.status).toBe(200);
  const qBody = await json<ListBody>(questions);
  expect(Array.isArray(qBody.questions)).toBe(true);
});