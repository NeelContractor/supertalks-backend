import { BookingStatus, type Prisma } from "@prisma/client";
import { openSlotsForRules } from "./scheduling";

type GuardTx = Prisma.TransactionClient;

/**
 * How long a PendingPayment booking keeps its slot reserved from other
 * clients while the payer is on the payment page. The hold is released early
 * when the payment fails, and re-armed every time the payer resumes checkout.
 * Should comfortably exceed the payer's worst realistic gateway time.
 * Default 10 minutes; override via CHECKOUT_HOLD_TTL_MS (milliseconds).
 */
export const CHECKOUT_HOLD_TTL_MS = Number(
  process.env.CHECKOUT_HOLD_TTL_MS ?? String(10 * 60 * 1000)
);

export function checkoutHoldUntil(): Date {
  return new Date(Date.now() + CHECKOUT_HOLD_TTL_MS);
}

/**
 * Where-fragment matching every booking that currently claims a slot against
 * OTHER clients: a settled booking (Confirmed/Rescheduled) or an unpaid
 * booking whose checkout hold is still running. Expired or legacy (NULL)
 * holds match nothing, so an abandoned checkout frees the slot again.
 *
 * Spread this into a booking where-clause together with astrologerId and the
 * time-range predicates. Remember to exclude the booking the caller owns
 * (e.g. `id: { not: own.id }`) when the caller should pass their own claim.
 */
export function slotClaimWhere(now: Date = new Date()): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: { in: [BookingStatus.Confirmed, BookingStatus.Rescheduled] } },
      { status: BookingStatus.PendingPayment, holdExpiresAt: { gt: now } },
    ],
  };
}

/**
 * Take the per-astrologer booking write lock. Call it first inside any
 * transaction that reads-then-writes bookings (create, reschedule, settle):
 * every such path takes the same key, so the overlap check and the write run
 * serially for one astrologer instead of racing each other. The lock is
 * released automatically when the transaction commits or rolls back.
 */
export async function lockAstrologerBookings(
  tx: GuardTx,
  astrologerId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"booking:" + astrologerId}::text, 0))`;
}

function pgCause(err: unknown): { code?: string; constraint?: string } | undefined {
  if (!err || typeof err !== "object") return undefined;
  const meta = (err as { meta?: unknown }).meta as
    | { driverAdapterError?: { cause?: { code?: string; constraint?: string } } }
    | undefined;
  return meta?.driverAdapterError?.cause ?? undefined;
}

/**
 * True when Postgres rejected the write because of the `bookings_no_overlap`
 * exclusion constraint (SQLSTATE 23P01) - i.e. the slot was taken by a
 * conflicting booking that slipped in despite the advisory lock (a write path
 * that does not take the lock, or a same-request retry).
 */
export function isSlotOverlapError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23P01") return true;
  const cause = pgCause(err);
  return cause?.code === "23P01";
}

/**
 * True when the insert lost the race on `bookings_client_id_idempotency_key`:
 * the same client already sent this Idempotency-Key, so the earlier booking
 * should be replayed instead of reported as an error.
 */
export function isIdempotencyKeyTaken(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code !== "P2002") return false;
  const cause = pgCause(err);
  if (cause?.constraint) return cause.constraint.includes("idempotency_key");
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const rendered = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return rendered.includes("idempotency_key");
}

/**
 * Authoritative "is this exact time still bookable?" re-check, meant to run
 * INSIDE the per-astrologer lock. It reloads the schedule fresh, so an
 * availability rule or exception committed by a concurrent writer cannot race
 * a booking (or reschedule) into a slot that is already gone: whichever side
 * gets the lock second sees the other's write.
 *
 * A slot matches when its start is exactly `start` and it covers `end` -
 * the start-equality mirrors what create validates, the coverage tolerates a
 * booking whose duration predates a slot-length change.
 */
export async function slotStillOpen(
  tx: Pick<Prisma.TransactionClient, "astrologerProfile">,
  astrologerId: string,
  start: Date,
  end: Date,
  dateKey: string
): Promise<boolean> {
  const fresh = await tx.astrologerProfile.findUnique({
    where: { id: astrologerId },
    include: {
      availabilityRules: { where: { isActive: true } },
      availabilityExceptions: { where: { date: new Date(`${dateKey}T00:00:00`) } },
    },
  });
  if (!fresh) return false;
  const open = openSlotsForRules(
    fresh,
    fresh.availabilityRules,
    fresh.availabilityExceptions,
    dateKey
  );
  return open.some(
    (s) => s.startAt === start.toISOString() && s.endAt >= end.toISOString()
  );
}
