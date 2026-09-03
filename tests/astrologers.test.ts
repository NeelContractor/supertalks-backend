import { test, expect, afterAll, beforeAll } from "bun:test";
import {
  createAstrologer,
  api,
  registerUser,
  testEmail,
  uniqueUsername,
  cleanupUsers,
  json,
} from "./helpers";

interface PublicProfileBody {
  user: { id: string; name: string };
  profile: { slug: string; status: string };
}

interface MeBody {
  user: { id: string; role: string };
  profile: { userId: string };
}
interface ProfileBody {
  profile: {
    bio?: string;
    specializations?: string[];
    languages?: string[];
    timezone?: string;
    questionPricePaise?: number;
    callPricePerSlotPaise?: number;
    slotDurationMinutes?: number;
    bufferMinutes?: number;
  };
}
interface ErrorBody {
  error?: string;
  details?: Record<string, unknown>;
}

let astro: Awaited<ReturnType<typeof createAstrologer>>;

beforeAll(async () => {
  astro = await createAstrologer();
});

afterAll(async () => {
  await cleanupUsers(astro.creds.email);
});

test("GET /astrologers/me returns own profile", async () => {
  const res = await api("GET", "/astrologers/me", { token: astro.accessToken });
  expect(res.status).toBe(200);

  const body = await json<MeBody>(res);
  expect(body.user.id).toBe(astro.user.id);
  expect(body.user.role).toBe("Astrologer");
  expect(body.profile.userId).toBe(astro.user.id);
});

test("GET /astrologers/me is forbidden for client role", async () => {
  const clientEmail = testEmail("client");
  const res = await registerUser({
    name: "Plain Client",
    email: clientEmail,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  const body = await json<{ accessToken: string }>(res);

  const meRes = await api("GET", "/astrologers/me", { token: body.accessToken });
  expect(meRes.status).toBe(403);
  await cleanupUsers(clientEmail);
});

test("PATCH /astrologers/me updates bio, specializations, languages, timezone", async () => {
  const res = await api("PATCH", "/astrologers/me", {
    token: astro.accessToken,
    body: {
      bio: "Expert in Vedic astrology",
      specializations: ["Vedic", "Numerology"],
      languages: ["English", "Hindi"],
      timezone: "Asia/Kolkata",
    },
  });
  expect(res.status).toBe(200);

  const body = await json<ProfileBody>(res);
  expect(body.profile.bio).toBe("Expert in Vedic astrology");
  expect(body.profile.specializations).toEqual(["Vedic", "Numerology"]);
  expect(body.profile.languages).toEqual(["English", "Hindi"]);
  expect(body.profile.timezone).toBe("Asia/Kolkata");
});

test("PATCH /astrologers/me rejects invalid specializations length", async () => {
  const res = await api("PATCH", "/astrologers/me", {
    token: astro.accessToken,
    body: { specializations: Array.from({ length: 11 }, (_, i) => `s${i}`) },
  });
  expect(res.status).toBe(400);
});

test("PATCH /astrologers/me/pricing updates pricing fields", async () => {
  const res = await api("PATCH", "/astrologers/me/pricing", {
    token: astro.accessToken,
    body: {
      questionPricePaise: 4900,
      callPricePerSlotPaise: 9900,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });
  expect(res.status).toBe(200);

  const body = await json<ProfileBody>(res);
  expect(body.profile.questionPricePaise).toBe(4900);
  expect(body.profile.callPricePerSlotPaise).toBe(9900);
  expect(body.profile.slotDurationMinutes).toBe(30);
  expect(body.profile.bufferMinutes).toBe(5);
});

test("PATCH /astrologers/me/pricing rejects invalid slot duration", async () => {
  const res = await api("PATCH", "/astrologers/me/pricing", {
    token: astro.accessToken,
    body: { slotDurationMinutes: 23 },
  });
  expect(res.status).toBe(400);
});

test("PATCH /astrologers/me/pricing rejects empty body", async () => {
  const res = await api("PATCH", "/astrologers/me/pricing", {
    token: astro.accessToken,
    body: {},
  });
  expect(res.status).toBe(400);
});

test("GET /astrologers/:slug returns public profile without auth", async () => {
  const res = await api("GET", `/astrologers/${astro.profile.slug}`);
  expect(res.status).toBe(200);

  const body = await json<PublicProfileBody>(res);
  expect(body.user.id).toBe(astro.user.id);
  expect(body.profile.slug).toBe(astro.profile.slug);
  expect(body.profile.status).toBe("Pending");
});

test("GET /astrologers/:slug returns 404 for unknown slug", async () => {
  const res = await api("GET", "/astrologers/does-not-exist");
  expect(res.status).toBe(404);
  expect((await json<{ error: string }>(res)).error).toBe("Astrologer not found");
});
