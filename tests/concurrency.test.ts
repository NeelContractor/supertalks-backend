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
import { db } from "../prisma/db";
import {
  markPaymentFailed,
  reapAbandonedCheckouts,
  ABANDONED_CHECKOUT_MS,
  settlePayment,
  ensureBookingSlotClaimable,
} from "../src/lib/settlement";
import { BOOKING_RATE_LIMIT_PER_MIN } from "../src/lib/rate-limit";

interface SlotsBody {
  slots: { startAt: string; endAt: string; yours?: boolean }[];
}
interface BookingBody {
  booking: { id: string; clientId: string; status: string };
  payment: { id: string; amountPaise: number; status: string } | null;
}

/** Date (YYYY-MM-DD) of the next occurrence of `day`, strictly in the future. */
function nextWeekday(day: number) {
  const now = new Date();
  const dist = (day - now.getUTCDay() + 7) % 7 || 7;
  const d = new Date(now);
  d.setUTCDate(now.getUTCDate() + dist);
  return d.toISOString().slice(0, 10);
}

async function makeClient(prefix: string) {
  const email = testEmail(prefix);
  const res = await registerUser({
    name: `${prefix} client`,
    email,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  const { accessToken } = await json<{ accessToken: string }>(res);
  return { email, token: accessToken };
}

function postBooking(
  token: string,
  astrologerId: string,
  startAt: string,
  idempotencyKey: string
) {
  return fetch(`${getBaseUrl()}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ astrologerId, startAt }),
  });
}

async function openSlots(slug: string, date: string) {
  const res = await fetch(`${getBaseUrl()}/astrologers/${slug}/slots?date=${date}`);
  const body = await json<SlotsBody>(res);
  return body.slots;
}

/** GET /slots with an optional identity, to check per-viewer differences. */
async function openSlotsAs(slug: string, date: string, token?: string) {
  const res = await fetch(`${getBaseUrl()}/astrologers/${slug}/slots?date=${date}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await json<SlotsBody>(res);
  return body.slots;
}

let freeAstro: Awaited<ReturnType<typeof createAstrologer>>;
let paidAstro: Awaited<ReturnType<typeof createAstrologer>>;
const emails: string[] = [];
const monday = nextWeekday(1);

beforeAll(async () => {
  freeAstro = await createAstrologer();
  paidAstro = await createAstrologer();

  // Free astrologer: bookings confirm immediately (no payment step), which is
  // the harshest race - the winner inserts a Confirmed row right away.
  await api("PATCH", "/astrologers/me/pricing", {
    token: freeAstro.accessToken,
    body: {
      questionPricePaise: 0,
      callPricePerSlotPaise: 0,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });
  await api("POST", "/astrologers/me/availability-rules", {
    token: freeAstro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });

  // Paid astrologer: bookings stay PendingPayment until settled.
  await api("PATCH", "/astrologers/me/pricing", {
    token: paidAstro.accessToken,
    body: {
      questionPricePaise: 4900,
      callPricePerSlotPaise: 9900,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });
  await api("POST", "/astrologers/me/availability-rules", {
    token: paidAstro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });
});

afterAll(async () => {
  await cleanupUsers(freeAstro.creds.email, paidAstro.creds.email, ...emails);
});

test("concurrent bookings for the same free slot: exactly one wins", async () => {
  const slots = await openSlots(freeAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const clients = await Promise.all([
    makeClient("race-a"),
    makeClient("race-b"),
    makeClient("race-c"),
  ]);
  emails.push(...clients.map((c) => c.email));

  const results = await Promise.all(
    clients.map((c, i) => postBooking(c.token, freeAstro.profile.id, slot.startAt, `race-win-${i}`))
  );

  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([201, 409, 409]);

  const bodies = await Promise.all(results.map((r) => json<BookingBody>(r).catch(() => null)));
  const winner = bodies.find((b) => b?.booking);
  expect(winner).toBeDefined();

  // The slot is gone from the public listing afterwards.
  const after = await openSlots(freeAstro.profile.slug, monday);
  expect(after.some((s) => s.startAt === slot.startAt)).toBe(false);
});

test("concurrent requests with the same Idempotency-Key create one booking", async () => {
  const slots = await openSlots(freeAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const client = await makeClient("race-idem");
  emails.push(client.email);

  const results = await Promise.all([
    postBooking(client.token, freeAstro.profile.id, slot.startAt, "race-idem-key"),
    postBooking(client.token, freeAstro.profile.id, slot.startAt, "race-idem-key"),
  ]);

  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([200, 201]);

  const bodies = await Promise.all(results.map((r) => json<BookingBody>(r)));
  const [bodyA, bodyB] = bodies;
  if (!bodyA || !bodyB) throw new Error("Expected booking bodies");
  expect(bodyA.booking.id).toBe(bodyB.booking.id);

  const rows = await db.booking.findMany({
    where: { clientId: bodyA.booking.clientId, idempotencyKey: "race-idem-key" },
  });
  expect(rows.length).toBe(1);
});

test("reusing an Idempotency-Key for a different slot is rejected", async () => {
  const slots = await openSlots(freeAstro.profile.slug, monday);
  const [slotA, slotB] = slots;
  if (!slotA || !slotB) throw new Error("Expected at least two open slots");

  const client = await makeClient("race-reuse");
  emails.push(client.email);

  const first = await postBooking(client.token, freeAstro.profile.id, slotA.startAt, "race-reuse-key");
  expect(first.status).toBe(201);

  const replay = await postBooking(client.token, freeAstro.profile.id, slotA.startAt, "race-reuse-key");
  expect(replay.status).toBe(200);

  const mismatch = await postBooking(client.token, freeAstro.profile.id, slotB.startAt, "race-reuse-key");
  expect(mismatch.status).toBe(409);
  const body = await json<{ error: string }>(mismatch);
  expect(body.error).toContain("Idempotency-Key");
});

test("an in-progress checkout hides the slot until the hold expires", async () => {
  const slots = await openSlots(paidAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const alice = await makeClient("race-alice");
  const bob = await makeClient("race-bob");
  emails.push(alice.email, bob.email);

  // Alice starts checkout: her unpaid booking now holds the slot.
  const aliceCreate = await postBooking(alice.token, paidAstro.profile.id, slot.startAt, "race-alice-key");
  expect(aliceCreate.status).toBe(201);
  const aliceBody = await json<BookingBody>(aliceCreate);
  if (!aliceBody.payment) throw new Error("Expected Alice's payment intent");

  // While the hold runs, Bob can neither see the slot nor book it.
  const during = await openSlots(paidAstro.profile.slug, monday);
  expect(during.some((s) => s.startAt === slot.startAt)).toBe(false);
  const bobBlocked = await postBooking(bob.token, paidAstro.profile.id, slot.startAt, "race-bob-key");
  expect(bobBlocked.status).toBe(409);

  // Alice never pays and the hold expires: the slot is up for grabs again.
  await db.booking.update({
    where: { id: aliceBody.booking.id },
    data: { holdExpiresAt: new Date(Date.now() - 1000) },
  });
  const after = await openSlots(paidAstro.profile.slug, monday);
  expect(after.some((s) => s.startAt === slot.startAt)).toBe(true);

  const bobCreate = await postBooking(bob.token, paidAstro.profile.id, slot.startAt, "race-bob-key");
  expect(bobCreate.status).toBe(201);
  const bobBody = await json<BookingBody>(bobCreate);
  if (!bobBody.payment) throw new Error("Expected Bob's payment intent");

  // Whoever completes payment wins; Alice's expired hold cannot claim it.
  const [aliceSettle, bobSettle] = await Promise.all([
    api("POST", `/payments/${aliceBody.payment.id}/complete`, { token: alice.token }),
    api("POST", `/payments/${bobBody.payment.id}/complete`, { token: bob.token }),
  ]);
  expect(aliceSettle.status).toBe(409);
  expect(bobSettle.status).toBe(200);

  const confirmed = await db.booking.count({
    where: { astrologerId: paidAstro.profile.id, startAt: slot.startAt, status: "Confirmed" },
  });
  expect(confirmed).toBe(1);

  // The loser's payment is failed, so nothing is left holding the slot.
  const alicePayment = await db.payment.findUnique({ where: { id: aliceBody.payment.id } });
  expect(alicePayment?.status).toBe("Failed");
});

test("a failed payment releases the slot immediately", async () => {
  const slots = await openSlots(paidAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const carl = await makeClient("race-carl");
  const dave = await makeClient("race-dave");
  emails.push(carl.email, dave.email);

  const carlCreate = await postBooking(carl.token, paidAstro.profile.id, slot.startAt, "race-carl-key");
  expect(carlCreate.status).toBe(201);
  const carlBody = await json<BookingBody>(carlCreate);
  if (!carlBody.payment) throw new Error("Expected Carl's payment intent");

  const held = await openSlots(paidAstro.profile.slug, monday);
  expect(held.some((s) => s.startAt === slot.startAt)).toBe(false);

  // The gateway reports the payment as failed - no waiting for the TTL.
  await markPaymentFailed(carlBody.payment.id);

  const freed = await openSlots(paidAstro.profile.slug, monday);
  expect(freed.some((s) => s.startAt === slot.startAt)).toBe(true);

  const daveCreate = await postBooking(dave.token, paidAstro.profile.id, slot.startAt, "race-dave-key");
  expect(daveCreate.status).toBe(201);
});

test("reschedule into an occupied slot is rejected, a free slot succeeds", async () => {
  const slots = await openSlots(freeAstro.profile.slug, monday);
  const [slotA, slotB, slotC] = slots;
  if (!slotA || !slotB || !slotC) throw new Error("Expected at least three open slots");

  const carol = await makeClient("race-carol");
  const dave = await makeClient("race-dave");
  emails.push(carol.email, dave.email);

  const carolRes = await postBooking(carol.token, freeAstro.profile.id, slotA.startAt, "race-carol-key");
  const daveRes = await postBooking(dave.token, freeAstro.profile.id, slotB.startAt, "race-dave-key");
  expect(carolRes.status).toBe(201);
  expect(daveRes.status).toBe(201);
  const carolBooking = (await json<BookingBody>(carolRes)).booking;

  // Moving onto Dave's confirmed slot must fail...
  const clash = await api("PATCH", `/bookings/${carolBooking.id}/reschedule`, {
    token: carol.token,
    body: { newStartAt: slotB.startAt },
  });
  expect(clash.status).toBe(409);

  // ...while an open slot works.
  const ok = await api("PATCH", `/bookings/${carolBooking.id}/reschedule`, {
    token: carol.token,
    body: { newStartAt: slotC.startAt },
  });
  expect(ok.status).toBe(200);
  const okBody = await json<BookingBody>(ok);
  expect(okBody.booking.status).toBe("Rescheduled");

  const confirmedAtB = await db.booking.count({
    where: { astrologerId: freeAstro.profile.id, startAt: slotB.startAt, status: "Confirmed" },
  });
  expect(confirmedAtB).toBe(1);
});

test("a failed payment lets the same client retry with a fresh intent", async () => {
  const slots = await openSlots(paidAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const erin = await makeClient("race-erin");
  emails.push(erin.email);

  const first = await postBooking(erin.token, paidAstro.profile.id, slot.startAt, "race-erin-key-1");
  expect(first.status).toBe(201);
  const firstBody = await json<BookingBody>(first);
  if (!firstBody.payment) throw new Error("Expected Erin's first payment intent");
  expect(firstBody.payment.status).toBe("Created");

  await markPaymentFailed(firstBody.payment.id);

  // The retry sends a fresh idempotency key (as the site does) and must come
  // back as a resumed booking with a NEW payable intent - not the dead one.
  const retry = await postBooking(erin.token, paidAstro.profile.id, slot.startAt, "race-erin-key-2");
  expect(retry.status).toBe(200);
  const retryBody = await json<BookingBody>(retry);
  expect(retryBody.booking.status).toBe("PendingPayment");
  if (!retryBody.payment) throw new Error("Expected a fresh payment intent");
  expect(retryBody.payment.id).not.toBe(firstBody.payment.id);
  expect(retryBody.payment.status).toBe("Created");

  // And the fresh intent settles the booking normally.
  const settle = await api("POST", `/payments/${retryBody.payment.id}/complete`, {
    token: erin.token,
  });
  expect(settle.status).toBe(200);
  const confirmed = await db.booking.findUnique({ where: { id: retryBody.booking.id } });
  expect(confirmed?.status).toBe("Confirmed");
  expect(confirmed?.holdExpiresAt).toBeNull();

  // The abandoned intent stays failed and attached to nothing bookable.
  const oldPayment = await db.payment.findUnique({ where: { id: firstBody.payment.id } });
  expect(oldPayment?.status).toBe("Failed");
});

test("cancelling before settlement fails the payment instead of confirming nothing", async () => {
  const slots = await openSlots(paidAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const frank = await makeClient("race-frank");
  emails.push(frank.email);

  const create = await postBooking(frank.token, paidAstro.profile.id, slot.startAt, "race-frank-key");
  expect(create.status).toBe(201);
  const body = await json<BookingBody>(create);
  if (!body.payment) throw new Error("Expected Frank's payment intent");

  // Frank cancels while the "gateway" is still processing his payment.
  const cancel = await api("PATCH", `/bookings/${body.booking.id}/cancel`, {
    token: frank.token,
    body: { reason: "changed my mind" },
  });
  expect(cancel.status).toBe(200);

  // The success callback describes the intent cancel already failed -
  // nothing settles, nothing is charged.
  const settle = await api("POST", `/payments/${body.payment.id}/complete`, { token: frank.token });
  expect(settle.status).toBe(200);
  expect((await json<{ payment: { status: string } }>(settle)).payment.status).toBe("Failed");

  const payment = await db.payment.findUnique({ where: { id: body.payment.id } });
  expect(payment?.status).toBe("Failed");
  const booking = await db.booking.findUnique({ where: { id: body.booking.id } });
  expect(booking?.status).toBe("CancelledByClient");

  // The slot is free for the next client again.
  const freed = await openSlots(paidAstro.profile.slug, monday);
  expect(freed.some((s) => s.startAt === slot.startAt)).toBe(true);
});

test("cancelling a pending checkout fails its payment intent", async () => {
  const slots = await openSlots(paidAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const hank = await makeClient("race-hank");
  emails.push(hank.email);

  const create = await postBooking(hank.token, paidAstro.profile.id, slot.startAt, "race-hank-key");
  expect(create.status).toBe(201);
  const body = await json<BookingBody>(create);
  if (!body.payment) throw new Error("Expected Hank's payment intent");
  expect(body.payment.status).toBe("Created");

  const cancel = await api("PATCH", `/bookings/${body.booking.id}/cancel`, {
    token: hank.token,
    body: { reason: "no longer needed" },
  });
  expect(cancel.status).toBe(200);

  // The intent dies with the checkout: no gateway order can be started now.
  const payment = await db.payment.findUnique({ where: { id: body.payment.id } });
  expect(payment?.status).toBe("Failed");

  // A late success callback describes the dead intent instead of settling.
  const settle = await api("POST", `/payments/${body.payment.id}/complete`, { token: hank.token });
  expect(settle.status).toBe(200);
  const settleBody = await json<{ payment: { status: string } }>(settle);
  expect(settleBody.payment.status).toBe("Failed");

  const booking = await db.booking.findUnique({ where: { id: body.booking.id } });
  expect(booking?.status).toBe("CancelledByClient");

  const freed = await openSlots(paidAstro.profile.slug, monday);
  expect(freed.some((s) => s.startAt === slot.startAt)).toBe(true);
});

test("reschedule only lands on open, unblocked slots", async () => {
  const offAstro = await createAstrologer();
  emails.push(offAstro.creds.email);
  await api("PATCH", "/astrologers/me/pricing", {
    token: offAstro.accessToken,
    body: {
      questionPricePaise: 0,
      callPricePerSlotPaise: 0,
      slotDurationMinutes: 30,
      bufferMinutes: 5,
    },
  });
  await api("POST", "/astrologers/me/availability-rules", {
    token: offAstro.accessToken,
    body: { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });

  const tina = await makeClient("race-tina");
  emails.push(tina.email);

  const slots = await openSlots(offAstro.profile.slug, monday);
  const [slotA, slotB] = slots;
  if (!slotA || !slotB) throw new Error("Expected at least two open slots");

  const create = await postBooking(tina.token, offAstro.profile.id, slotA.startAt, "race-tina-key");
  expect(create.status).toBe(201);
  const bookingId = (await json<BookingBody>(create)).booking.id;

  // Another slot on the same open day works.
  const ok = await api("PATCH", `/bookings/${bookingId}/reschedule`, {
    token: tina.token,
    body: { newStartAt: slotB.startAt },
  });
  expect(ok.status).toBe(200);

  // A day with no availability rules is not bookable.
  const tuesday = new Date(`${monday}T00:00:00Z`);
  tuesday.setUTCDate(tuesday.getUTCDate() + 1);
  const offDay = await api("PATCH", `/bookings/${bookingId}/reschedule`, {
    token: tina.token,
    body: { newStartAt: `${tuesday.toISOString().slice(0, 10)}T10:00:00.000Z` },
  });
  expect(offDay.status).toBe(409);
  expect((await json<{ error: string }>(offDay)).error).toBe("Slot is not available for booking");

  // Block part of a future Monday: that window is gone even though the
  // weekday normally has hours.
  const nextMonday = new Date(`${monday}T00:00:00Z`);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const block = await api("POST", "/astrologers/me/exceptions", {
    token: offAstro.accessToken,
    body: {
      date: nextMonday.toISOString().slice(0, 10),
      isBlocked: true,
      startTime: "14:00",
      endTime: "15:00",
      reason: "Day off",
      resolve: "trim-rules",
    },
  });
  expect(block.status).toBe(201);

  const blocked = await api("PATCH", `/bookings/${bookingId}/reschedule`, {
    token: tina.token,
    body: { newStartAt: `${nextMonday.toISOString().slice(0, 10)}T14:00:00.000Z` },
  });
  expect(blocked.status).toBe(409);
  expect((await json<{ error: string }>(blocked)).error).toBe("Slot is not available for booking");

  // The normal day keeps rescheduling fine after the trim.
  const stillOpen = await openSlots(offAstro.profile.slug, monday);
  const newTarget = stillOpen.find((s) => s.startAt !== slotB.startAt);
  if (!newTarget) throw new Error("Expected an open slot after the trim");
  const ok2 = await api("PATCH", `/bookings/${bookingId}/reschedule`, {
    token: tina.token,
    body: { newStartAt: newTarget.startAt },
  });
  expect(ok2.status).toBe(200);
});

test("an abandoned checkout is reaped: cancelled booking, failed intent", async () => {
  const slots = await openSlots(paidAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const ivy = await makeClient("race-ivy");
  emails.push(ivy.email);

  const create = await postBooking(ivy.token, paidAstro.profile.id, slot.startAt, "race-ivy-key");
  expect(create.status).toBe(201);
  const body = await json<BookingBody>(create);
  if (!body.payment) throw new Error("Expected Ivy's payment intent");

  // Nobody paid, and the hold expired more than a day ago.
  await db.booking.update({
    where: { id: body.booking.id },
    data: { holdExpiresAt: new Date(Date.now() - ABANDONED_CHECKOUT_MS - 60_000) },
  });

  const reaped = await reapAbandonedCheckouts();
  expect(reaped).toBeGreaterThanOrEqual(1);

  const booking = await db.booking.findUnique({ where: { id: body.booking.id } });
  expect(booking?.status).toBe("CancelledByClient");
  expect(booking?.cancellationReason).toContain("abandoned");
  const payment = await db.payment.findUnique({ where: { id: body.payment.id } });
  expect(payment?.status).toBe("Failed");

  // A fresh attempt starts a brand-new booking instead of resuming the
  // reaped one.
  const again = await postBooking(ivy.token, paidAstro.profile.id, slot.startAt, "race-ivy-key-2");
  expect(again.status).toBe(201);
  const againBody = await json<BookingBody>(again);
  expect(againBody.booking.id).not.toBe(body.booking.id);
  expect(againBody.payment?.id).not.toBe(body.payment.id);
});

test("your own checkout hold stays visible to you, hidden from everyone else", async () => {
  const slots = await openSlots(paidAstro.profile.slug, monday);
  const slot = slots[0];
  if (!slot) throw new Error("Expected at least one open slot");

  const lily = await makeClient("race-lily");
  const mongo = await makeClient("race-mongo");
  emails.push(lily.email, mongo.email);

  const create = await postBooking(lily.token, paidAstro.profile.id, slot.startAt, "race-lily-key");
  expect(create.status).toBe(201);
  const body = await json<BookingBody>(create);
  if (!body.payment) throw new Error("Expected Lily's payment intent");

  // Anonymous visitors and other clients don't see the held slot at all.
  const anon = await openSlotsAs(paidAstro.profile.slug, monday);
  expect(anon.some((s) => s.startAt === slot.startAt)).toBe(false);
  const otherView = await openSlotsAs(paidAstro.profile.slug, monday, mongo.token);
  expect(otherView.some((s) => s.startAt === slot.startAt)).toBe(false);

  // Lily sees her own slot, flagged as hers.
  const lilyView = await openSlotsAs(paidAstro.profile.slug, monday, lily.token);
  const mine = lilyView.find((s) => s.startAt === slot.startAt);
  expect(mine).toBeDefined();
  expect(mine!.yours).toBe(true);

  // Once she pays, it is a plain booking and leaves the picker entirely.
  const settle = await api("POST", `/payments/${body.payment.id}/complete`, { token: lily.token });
  expect(settle.status).toBe(200);
  const after = await openSlotsAs(paidAstro.profile.slug, monday, lily.token);
  expect(after.some((s) => s.startAt === slot.startAt)).toBe(false);
});

test("booking POSTs are rate-limited per client", async () => {
  const slug = paidAstro.profile.slug;
  const startAt = (await openSlots(slug, monday))[0]!.startAt;
  const spam = await makeClient("race-spam");
  emails.push(spam.email);

  // Hammering the same slot with fresh idempotency keys: the first batch is
  // admitted (mostly harmless replays), the overflow gets 429. A minute-long
  // sliding window keeps every one of these attempts inside the same bucket.
  const statuses: number[] = [];
  for (let i = 0; i < BOOKING_RATE_LIMIT_PER_MIN + 5; i++) {
    statuses.push((await postBooking(spam.token, paidAstro.profile.id, startAt, `spam-${i}`)).status);
  }

  const throttled = statuses.filter((s) => s === 429).length;
  expect(statuses[0]).not.toBe(429);
  expect(throttled).toBe(5);
});

test("ensureBookingSlotClaimable blocks a payment whose slot was lost", async () => {
  const slug = paidAstro.profile.slug;
  const startAt = (await openSlots(slug, monday))[0]!.startAt;
  const alice = await makeClient("race-ensure-a");
  const bob = await makeClient("race-ensure-b");
  emails.push(alice.email, bob.email);

  const create = await postBooking(alice.token, paidAstro.profile.id, startAt, "ensure-a");
  expect(create.status).toBe(201);
  const bodyA = await json<BookingBody>(create);
  const paymentA = bodyA.payment!.id;

  // Slot still free: the client may be sent to the gateway.
  expect(await ensureBookingSlotClaimable(paymentA)).toBe(true);

  // Alice's hold expires, Bob takes the slot.
  await db.booking.updateMany({
    where: { paymentId: paymentA },
    data: { holdExpiresAt: new Date(Date.now() - 1) },
  });
  const bobCreate = await postBooking(bob.token, paidAstro.profile.id, startAt, "ensure-b");
  expect(bobCreate.status).toBe(201);
  const bodyB = await json<BookingBody>(bobCreate);

  // Alice's intent is now dead on arrival: refused before the gateway order,
  // payment failed, and Bob's untouched.
  expect(await ensureBookingSlotClaimable(paymentA)).toBe(false);
  const alicePay = await db.payment.findUnique({ where: { id: paymentA } });
  expect(alicePay?.status).toBe("Failed");
  const bobPay = await db.payment.findUnique({ where: { id: bodyB.payment!.id } });
  expect(bobPay?.status).toBe("Created");
});

test("concurrent duplicate question settlements deliver a paid message exactly once", async () => {
  const client = await makeClient("race-q");
  emails.push(client.email);

  const q = await api("POST", "/questions", {
    token: client.token,
    body: {
      astrologerId: paidAstro.profile.id,
      questionText: "Double settle question.",
      category: "Health",
    },
  });
  expect(q.status).toBe(201);
  const { question } = await json<{ question: { id: string } }>(q);

  const msg = await api("POST", `/questions/${question.id}/messages`, {
    token: client.token,
    body: { body: "Pay once, deliver once." },
  });
  expect(msg.status).toBe(201);
  const intent = await json<{ payment: { id: string } }>(msg);

  // Two settle calls race on the same Created intent; only one may deliver
  // the paid message, the loser describes the winner's outcome.
  const [a, b] = await Promise.all([
    settlePayment(intent.payment.id, "ps-1"),
    settlePayment(intent.payment.id, "ps-2"),
  ]);
  expect(a?.conflict).toBe(false);
  expect(b?.conflict).toBe(false);

  const thread = await api("GET", `/questions/${question.id}/messages`, { token: client.token });
  const body = await json<{ messages: { body: string }[] }>(thread);
  expect(body.messages.filter((m) => m.body === "Pay once, deliver once.")).toHaveLength(1);
});

test("cancelling a paid session refunds the payment", async () => {
  const slug = paidAstro.profile.slug;
  const startAt = (await openSlots(slug, monday))[0]!.startAt;
  const nora = await makeClient("race-refund");
  emails.push(nora.email);

  const create = await postBooking(nora.token, paidAstro.profile.id, startAt, "refund-key");
  expect(create.status).toBe(201);
  const body = await json<BookingBody>(create);

  const settle = await api("POST", `/payments/${body.payment!.id}/complete`, { token: nora.token });
  expect(settle.status).toBe(200);

  const cancel = await api("PATCH", `/bookings/${body.booking.id}/cancel`, {
    token: nora.token,
    body: { reason: "change of plans" },
  });
  expect(cancel.status).toBe(200);
  const { booking: cancelled } = await json<{ booking: { status: string } }>(cancel);
  expect(cancelled.status).toBe("CancelledByClient");

  const payment = await db.payment.findUnique({ where: { id: body.payment!.id } });
  expect(payment?.status).toBe("Refunded");
});
