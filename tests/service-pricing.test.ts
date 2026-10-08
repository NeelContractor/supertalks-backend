import { test, expect, afterAll, beforeAll, describe } from "bun:test";
import { db } from "../prisma/db";
import {
  DEFAULT_SERVICE_PRICE_PAISE,
  ensureDefaultTemplates,
  resolveService,
} from "../src/lib/site";
import {
  api,
  cleanupUsers,
  createAstrologer,
  getBaseUrl,
  json,
  registerUser,
  testEmail,
  uniqueUsername,
} from "./helpers";

const QUESTION_PRICE = 4900;
const SLOT_PRICE = 9900;
const SERVICE_QUESTION_PRICE = 1000;
const SERVICE_SLOT_PRICE = 7777;

let astro: Awaited<ReturnType<typeof createAstrologer>>;
let clientEmail = "";
let clientToken = "";
let monday = "";
let slotStartAts: string[] = [];

interface BatchBody {
  payment: { amountPaise: number } | null;
}
interface BookingPaymentBody {
  payment: { amountPaise: number } | null;
}
interface ErrorBody {
  error?: string;
}

beforeAll(async () => {
  // The seeded default template's schema is synced on server boot, which the
  // test app skips. Sync it here so the new service itemProps exist in the DB
  // template the resolver reads.
  await ensureDefaultTemplates();

  astro = await createAstrologer();

  await api("PATCH", "/astrologers/me/pricing", {
    token: astro.accessToken,
    body: {
      questionPricePaise: QUESTION_PRICE,
      callPricePerSlotPaise: SLOT_PRICE,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });

  await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });

  // Two services: index 0 is a question, index 1 is a bookable slot. Both
  // carry their own price so it is distinguishable from the profile price.
  await db.astrologerProfile.update({
    where: { id: astro.profile.id },
    data: {
      templateData: {
        sections: {
          services: {
            props: {
              items: [
                {
                  title: "Ask about my career",
                  body: "A written question about your career path.",
                  type: "question",
                  pricePaise: SERVICE_QUESTION_PRICE,
                  durationMinutes: 0,
                },
                {
                  title: "Full birth chart session",
                  body: "A live session covering your whole chart.",
                  type: "slot",
                  pricePaise: SERVICE_SLOT_PRICE,
                  durationMinutes: 45,
                },
              ],
            },
          },
        },
      },
    },
  });

  const now = new Date();
  const distToMonday = (1 - now.getUTCDay() + 7) % 7;
  const m = new Date(now);
  m.setUTCDate(now.getUTCDate() + distToMonday);
  monday = m.toISOString().slice(0, 10);

  clientEmail = testEmail("svcclient");
  const res = await registerUser({
    name: "Service Pricing Client",
    email: clientEmail,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  clientToken = (await json<{ accessToken: string }>(res)).accessToken;

  // Book against real generated slots rather than guessed times: the slot
  // step is slotDuration + buffer, so :00/:30 assumptions are wrong.
  const slotsRes = await api("GET", `/astrologers/${astro.profile.slug}/slots?date=${monday}`);
  const slotsBody = await json<{ slots: { startAt: string }[] }>(slotsRes);
  slotStartAts = slotsBody.slots.map((s) => s.startAt);
});

afterAll(async () => {
  await cleanupUsers(astro.creds.email, clientEmail);
});

function orderQuestion(extra: Record<string, unknown>) {
  return api("POST", "/questions/batch", {
    token: clientToken,
    body: {
      astrologerId: astro.profile.id,
      items: [
        {
          questionText: "What does my career chart suggest for the year ahead?",
          category: "Career",
          ...extra,
        },
      ],
    },
  });
}

function bookSlot(slotIndex: number, extra: Record<string, unknown> = {}) {
  const startAt = slotStartAts[slotIndex];
  if (!startAt) throw new Error(`No slot at index ${slotIndex}`);
  return fetch(`${getBaseUrl()}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `svc-${slotIndex}-${Math.random().toString(16).slice(2)}`,
      Authorization: `Bearer ${clientToken}`,
    },
    body: JSON.stringify({
      astrologerId: astro.profile.id,
      startAt,
      ...extra,
    }),
  });
}

describe("question service pricing", () => {
  test("a question service charges the price stored on the service", async () => {
    const res = await orderQuestion({ serviceId: "services:0" });
    expect(res.status).toBe(201);
    expect((await json<BatchBody>(res)).payment?.amountPaise).toBe(SERVICE_QUESTION_PRICE);
  });

  test("a client-supplied price is ignored in favour of the stored service price", async () => {
    const res = await orderQuestion({ serviceId: "services:0", pricePaise: 1 });
    expect(res.status).toBe(201);
    expect((await json<BatchBody>(res)).payment?.amountPaise).toBe(SERVICE_QUESTION_PRICE);
  });

  test("an item with no serviceId falls back to the profile question price", async () => {
    const res = await orderQuestion({});
    expect(res.status).toBe(201);
    expect((await json<BatchBody>(res)).payment?.amountPaise).toBe(QUESTION_PRICE);
  });

  test("a slot service cannot be bought as a question", async () => {
    const res = await orderQuestion({ serviceId: "services:1" });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error).toMatch(/booked as a session/i);
  });

  test("an unknown serviceId is rejected", async () => {
    const res = await orderQuestion({ serviceId: "services:99" });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error).toMatch(/no longer available/i);
  });

  test("a malformed serviceId is rejected", async () => {
    const res = await orderQuestion({ serviceId: "not-a-service" });
    expect(res.status).toBe(400);
  });

  test("a mixed batch sums each item's own price", async () => {
    const res = await api("POST", "/questions/batch", {
      token: clientToken,
      body: {
        astrologerId: astro.profile.id,
        items: [
          {
            questionText: "First question about my chart please?",
            serviceId: "services:0",
          },
          {
            questionText: "Second question about my chart please?",
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect((await json<BatchBody>(res)).payment?.amountPaise).toBe(
      SERVICE_QUESTION_PRICE + QUESTION_PRICE
    );
  });
});

describe("slot service pricing", () => {
  test("a slot service charges the price stored on the service", async () => {
    const res = await bookSlot(0, { serviceId: "services:1" });
    expect(res.status).toBe(201);
    expect((await json<BookingPaymentBody>(res)).payment?.amountPaise).toBe(SERVICE_SLOT_PRICE);
  });

  test("a client-supplied price is ignored in favour of the stored service price", async () => {
    const res = await bookSlot(1, { serviceId: "services:1", pricePaise: 1 });
    expect(res.status).toBe(201);
    expect((await json<BookingPaymentBody>(res)).payment?.amountPaise).toBe(SERVICE_SLOT_PRICE);
  });

  test("a booking with no serviceId falls back to the profile slot price", async () => {
    const res = await bookSlot(2);
    expect(res.status).toBe(201);
    expect((await json<BookingPaymentBody>(res)).payment?.amountPaise).toBe(SLOT_PRICE);
  });

  test("a question service cannot be booked as a slot", async () => {
    const res = await bookSlot(3, { serviceId: "services:0" });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error).toMatch(/not a bookable session/i);
  });

  test("an unknown serviceId is rejected", async () => {
    const res = await bookSlot(4, { serviceId: "services:99" });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error).toMatch(/no longer available/i);
  });

  test("birth details sent with the booking are stored on the booking", async () => {
    const clientDetails = {
      clientName: "Jane Doe",
      birthDate: "1990-01-01",
      birthTime: "14:30",
      birthPlace: "Mumbai, India",
    };
    const res = await bookSlot(5, { serviceId: "services:1", clientDetails });
    expect(res.status).toBe(201);
    const body = await json<{ booking: { id: string } }>(res);
    const booking = await db.booking.findUnique({
      where: { id: body.booking.id },
      select: { clientDetails: true },
    });
    expect(booking?.clientDetails).toMatchObject(clientDetails);
  });
});

describe("services saved before the per-service fields existed", () => {
  // A stored service only has title/body. buildSite must fill the new fields
  // from the template defaults so existing astrologers keep working. A missing
  // price takes the default card price rather than 0, and a missing length
  // stays 0 so a card never advertises a session length on a question.
  // Built lazily: `astro` only exists once beforeAll has run.
  const legacy = () => ({
    templateId: astro.profile.templateId,
    templateData: {
      sections: {
        services: {
          props: {
            items: [
              { title: "Legacy Q", body: "stored before the new fields" },
              { title: "Legacy S", body: "stored before the new fields" },
            ],
          },
        },
      },
    },
  });

  test("a legacy service resolves with a type and the default card price", async () => {
    expect(await resolveService(legacy(), "services:0")).toEqual({
      serviceId: "services:0",
      index: 0,
      title: "Legacy Q",
      type: "question",
      pricePaise: DEFAULT_SERVICE_PRICE_PAISE,
      durationMinutes: 0,
    });
  });

  test("a legacy service still resolves to a bookable session type", async () => {
    expect((await resolveService(legacy(), "services:1"))?.type).toBe("slot");
  });

  test("out-of-range and malformed service ids resolve to null", async () => {
    expect(await resolveService(legacy(), "services:9")).toBeNull();
    expect(await resolveService(legacy(), "garbage")).toBeNull();
  });
});
