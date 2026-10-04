import { test, expect, afterAll } from "bun:test";
import {
  registerUser,
  testEmail,
  uniqueUsername,
  cleanupUsers,
  json,
} from "./helpers";
import {
  isUniqueConstraintError,
  randomAstrologerSlug,
  runWithUniqueSlug,
  uniqueConstraintField,
} from "../src/lib/unique-slug";

/**
 * `User.username` is unique-indexed, and the astrologer's public profile slug is
 * too. These tests pin the behaviour a caller can observe: a duplicate username
 * is always a clean 409 (never a 500), and two astrologers never share an
 * identity.
 */

const password = "StrongPass1";
const emails: string[] = [];

function track(email: string) {
  emails.push(email);
  return email;
}

/** A structural stand-in for Prisma's P2002 unique violation. */
function uniqueViolation(field: string) {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: [field] },
  });
}

afterAll(async () => {
  await cleanupUsers(...emails);
});

test("a username already taken by a client is rejected for an astrologer", async () => {
  const username = uniqueUsername();
  const clientEmail = track(testEmail("uname-client"));

  const first = await registerUser({
    name: "First Client",
    email: clientEmail,
    username,
    password,
  });
  expect(first.status).toBe(201);

  const second = await registerUser({
    name: "Second Astrologer",
    email: track(testEmail("uname-astro")),
    username,
    password,
    role: "astrologer",
  });
  expect(second.status).toBe(409);
  const body = await json<{ error?: string }>(second);
  expect(body.error).toContain("username");
});

test("a username already taken by an astrologer is rejected", async () => {
  const username = uniqueUsername();

  const first = await registerUser({
    name: "First Astrologer",
    email: track(testEmail("uname-astro")),
    username,
    password,
    role: "astrologer",
  });
  expect(first.status).toBe(201);

  const second = await registerUser({
    name: "Second Astrologer",
    email: track(testEmail("uname-astro")),
    username,
    password,
    role: "astrologer",
  });
  expect(second.status).toBe(409);
  const body = await json<{ error?: string }>(second);
  expect(body.error).toContain("username");
});

test("usernames are compared case-insensitively", async () => {
  const username = uniqueUsername();

  const first = await registerUser({
    name: "Case User",
    email: track(testEmail("uname-case")),
    username: username.toUpperCase(),
    password,
  });
  expect(first.status).toBe(201);

  const second = await registerUser({
    name: "Case User Two",
    email: track(testEmail("uname-case")),
    username: username.toLowerCase(),
    password,
    role: "astrologer",
  });
  expect(second.status).toBe(409);
  const body = await json<{ error?: string }>(second);
  expect(body.error).toContain("username");
});

test("a rejected duplicate username leaves the first account usable", async () => {
  const username = uniqueUsername();
  const email = track(testEmail("uname-intact"));

  await registerUser({ name: "Keeper", email, username, password });
  const dup = await registerUser({
    name: "Dupe",
    email: track(testEmail("uname-dupe")),
    username,
    password,
  });
  expect(dup.status).toBe(409);

  // The original row must be untouched: no partial write from the loser.
  const retry = await registerUser({
    name: "Dupe",
    email: track(testEmail("uname-dupe")),
    username: `x${username}`,
    password,
  });
  expect(retry.status).toBe(201);
});

test("two astrologers are issued different profile slugs", async () => {
  const slugs: string[] = [];

  for (let i = 0; i < 3; i++) {
    const res = await registerUser({
      name: `Slug Astrologer ${i}`,
      email: track(testEmail("uname-slug")),
      username: uniqueUsername(),
      password,
      role: "astrologer",
    });
    expect(res.status).toBe(201);
    const body = await json<{ profile: { slug: string } }>(res);
    slugs.push(body.profile.slug);
  }

  expect(new Set(slugs).size).toBe(slugs.length);
  for (const slug of slugs) {
    expect(slug).toMatch(/^astro-[0-9a-f]{12}$/);
  }
});

test("runWithUniqueSlug retries on a slug collision and returns the next slug", async () => {
  const candidates = ["astro-taken", "astro-free"];
  let calls = 0;
  const seen: string[] = [];

  const result = await runWithUniqueSlug(
    async (slug) => {
      seen.push(slug);
      if (slug === "astro-taken") throw uniqueViolation("slug");
      return slug;
    },
    { generate: () => candidates[calls++] ?? "astro-fallback" },
  );

  expect(result).toBe("astro-free");
  expect(seen).toEqual(["astro-taken", "astro-free"]);
});

test("runWithUniqueSlug rethrows errors that are not slug collisions", async () => {
  let calls = 0;
  const boom = new Error("connection lost");

  await expect(
    runWithUniqueSlug(
      async () => {
        calls++;
        throw boom;
      },
      { generate: () => `astro-${calls}` },
    ),
  ).rejects.toBe(boom);
  expect(calls).toBe(1);
});

test("runWithUniqueSlug gives up after the attempt limit", async () => {
  let calls = 0;
  await expect(
    runWithUniqueSlug(
      async () => {
        calls++;
        throw uniqueViolation("slug");
      },
      { attempts: 3, generate: () => `astro-${calls}` },
    ),
  ).rejects.toMatchObject({ code: "P2002" });
  expect(calls).toBe(3);
});

test("unique violations are classified by column", () => {
  expect(isUniqueConstraintError(uniqueViolation("username"))).toBe(true);
  expect(uniqueConstraintField(uniqueViolation("username"))).toBe("username");
  expect(uniqueConstraintField(uniqueViolation("slug"))).toBe("slug");
  expect(isUniqueConstraintError(new Error("nope"))).toBe(false);
  expect(uniqueConstraintField(new Error("nope"))).toBeNull();
});

test("generated slugs are unique in a large-enough sample", () => {
  const sample = new Set<string>();
  for (let i = 0; i < 5000; i++) sample.add(randomAstrologerSlug());
  expect(sample.size).toBe(5000);
});