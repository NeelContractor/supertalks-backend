import { test, expect, afterAll, beforeAll } from "bun:test";
import {
  createAstrologer,
  api,
  testEmail,
  uniqueUsername,
  cleanupUsers,
  json,
} from "./helpers";

interface Rule {
  id: string;
  dayOfWeek: number;
}
interface RulesBody {
  rules: Rule[];
}
interface RuleBody {
  rule: Rule;
}
interface Exception {
  id: string;
  date: string;
  reason?: string;
}
interface ExceptionsBody {
  exceptions: Exception[];
}
interface SlotsBody {
  slots: { startAt: string; endAt: string }[];
}

let astro: Awaited<ReturnType<typeof createAstrologer>>;

beforeAll(async () => {
  astro = await createAstrologer();
});

afterAll(async () => {
  await cleanupUsers(astro.creds.email);
});

test("POST /astrologers/me/availability-rules creates a rule", async () => {
  const res = await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });
  expect(res.status).toBe(201);

  const body = await json<RuleBody>(res);
  expect(body.rule.dayOfWeek).toBe(1);
});

test("POST availability rule rejects startTime after endTime", async () => {
  const res = await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 2, startTime: "18:00", endTime: "09:00" },
  });
  expect(res.status).toBe(400);
});

test("GET availability-rules lists rules", async () => {
  const res = await api("GET", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
  });
  expect(res.status).toBe(200);
  const body = await json<RulesBody>(res);
  expect(Array.isArray(body.rules)).toBe(true);
  expect(body.rules.length).toBeGreaterThanOrEqual(1);
});

test("slots returns computed open slots for a rule day", async () => {
  const now = new Date();
  const day = now.getUTCDay();
  const distToMonday = (1 - day + 7) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + distToMonday);
  const date = monday.toISOString().slice(0, 10);

  await api("PATCH", "/astrologers/me/pricing", {
    token: astro.accessToken,
    body: {
      questionPricePaise: 4900,
      callPricePerSlotPaise: 9900,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });

  const res = await api("GET", `/astrologers/${astro.profile.slug}/slots?date=${date}`);
  expect(res.status).toBe(200);
  const body = await json<SlotsBody>(res);
  expect(Array.isArray(body.slots)).toBe(true);
  // 09:00-17:00 at 35-min spacing (30 slot + 5 buffer) => 13 slots
  expect(body.slots.length).toBe(13);
});

test("slots returns 400 when date missing", async () => {
  const res = await api("GET", `/astrologers/${astro.profile.slug}/slots`);
  expect(res.status).toBe(400);
});

test("DELETE availability rule removes it", async () => {
  const created = await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 3, startTime: "10:00", endTime: "12:00" },
  });
  const rule = (await json<RuleBody>(created)).rule;

  const del = await api("DELETE", `/astrologers/me/availability-rules/${rule.id}`, {
    token: astro.accessToken,
  });
  expect(del.status).toBe(200);

  const list = await api("GET", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
  });
  const listBody = await json<RulesBody>(list);
  expect(listBody.rules.find((r) => r.id === rule.id)).toBeUndefined();
});

test("exceptions create and list", async () => {
  const created = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: { date: "2026-12-25", isBlocked: true, reason: "Holiday" },
  });
  expect(created.status).toBe(201);

  const list = await api("GET", "/astrologers/me/exceptions", {
    token: astro.accessToken,
  });
  const body = await json<ExceptionsBody>(list);
  expect(body.exceptions.some((e) => e.reason === "Holiday")).toBe(true);
});

test("a second exception for the same date replaces the first (no clash)", async () => {
  const first = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: { date: "2026-12-26", isBlocked: true, reason: "Plan A" },
  });
  expect(first.status).toBe(201);

  const second = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: { date: "2026-12-26", isBlocked: false, startTime: "10:00", endTime: "14:00", reason: "Plan B" },
  });
  expect(second.status).toBe(201);

  const list = await api("GET", "/astrologers/me/exceptions", {
    token: astro.accessToken,
  });
  const body = await json<ExceptionsBody>(list);
  const matching = body.exceptions.filter((e) => e.date.slice(0, 10) === "2026-12-26");
  expect(matching).toHaveLength(1);
  expect(matching[0]?.reason).toBe("Plan B");
});

test("adjusted exception without times is rejected", async () => {
  const res = await api("POST", "/astrologers/me/exceptions", {
    token: astro.accessToken,
    body: { date: "2026-12-27", isBlocked: false },
  });
  expect(res.status).toBe(400);
});

test("overlapping availability rules for the same day are rejected", async () => {
  const res = await api("POST", "/astrologers/me/availability-rules", {
    token: astro.accessToken,
    body: { dayOfWeek: 1, startTime: "12:00", endTime: "14:00" },
  });
  expect(res.status).toBe(400);
});

test("bulk availability template applies windows to selected days and leaves others alone", async () => {
  const res = await api("POST", "/astrologers/me/availability-rules/bulk", {
    token: astro.accessToken,
    body: {
      daysOfWeek: [0, 4],
      windows: [
        { startTime: "09:00", endTime: "13:00" },
        { startTime: "14:00", endTime: "19:00" },
      ],
    },
  });
  expect(res.status).toBe(200);
  const body = await json<RulesBody>(res);

  const fri = body.rules.filter((r) => r.dayOfWeek === 4);
  expect(fri).toHaveLength(2);
  const sunday = body.rules.filter((r) => r.dayOfWeek === 0);
  expect(sunday).toHaveLength(2);
  // Existing Monday rule is untouched.
  const monday = body.rules.filter((r) => r.dayOfWeek === 1);
  expect(monday.length).toBeGreaterThanOrEqual(1);
});

test("bulk availability template with empty windows clears the selected days", async () => {
  const res = await api("POST", "/astrologers/me/availability-rules/bulk", {
    token: astro.accessToken,
    body: { daysOfWeek: [0], windows: [] },
  });
  expect(res.status).toBe(200);
  const body = await json<RulesBody>(res);
  expect(body.rules.filter((r) => r.dayOfWeek === 0)).toHaveLength(0);
});

test("bulk availability template rejects overlapping windows", async () => {
  const res = await api("POST", "/astrologers/me/availability-rules/bulk", {
    token: astro.accessToken,
    body: {
      daysOfWeek: [5],
      windows: [
        { startTime: "09:00", endTime: "15:00" },
        { startTime: "14:00", endTime: "19:00" },
      ],
    },
  });
  expect(res.status).toBe(400);
});
