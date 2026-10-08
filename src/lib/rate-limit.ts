const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

/** Max POST /bookings calls a single user may make per minute. */
export const BOOKING_RATE_LIMIT_PER_MIN = Number(
  process.env.BOOKING_RATE_LIMIT ?? "30"
);

const hits = new Map<string, number[]>();

/**
 * Sliding-window rate limiter keyed by user id. Booking creates serialize on
 * a per-astrologer advisory lock, so a spammer can queue a pile of replayed
 * idempotent creates behind one lock; this rejects the burst before it
 * reaches the database. In-memory per process, which is all a single
 * instance needs.
 */
export function allowBookingAttempt(userId: string): {
  allowed: boolean;
  retryAfterSec: number;
} {
  const now = Date.now();
  const arr = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);

  if (arr.length >= BOOKING_RATE_LIMIT_PER_MIN) {
    hits.set(userId, arr);
    const retryAfterSec = Math.max(
      1,
      Math.ceil((arr[0]! + WINDOW_MS - now) / 1000)
    );
    return { allowed: false, retryAfterSec };
  }

  arr.push(now);
  hits.set(userId, arr);

  // Bounded growth: drop keys whose window has fully expired once the map
  // gets large.
  if (hits.size > MAX_KEYS) {
    for (const [key, times] of hits) {
      if (times[times.length - 1]! < now - WINDOW_MS) hits.delete(key);
    }
  }

  return { allowed: true, retryAfterSec: 0 };
}