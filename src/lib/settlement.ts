import { db } from "../../prisma/db";
import {
  BookingStatus,
  PaymentFor,
  PaymentStatus,
  QuestionStatus,
  UserRole,
  type Booking,
  type Prisma,
  type Question,
} from "@prisma/client";
import { broadcastMessage, broadcastQuestionUpdate } from "./realtime";
import { lockAstrologerBookings, isSlotOverlapError, slotClaimWhere } from "./booking-guards";

/**
 * Shared payment settlement: turns a Created payment intent into a delivered
 * outcome (confirmed bookings / activated questions / delivered chat message).
 * Used by the mock "complete" route AND by the PhonePe webhook/status paths so
 * both providers settle through the exact same logic.
 */

export interface SerializedPayment {
  id: string;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  purpose: PaymentFor;
  providerOrderId?: string;
  clientDetails?: unknown;
}

export interface MessageWithSender {
  id: string;
  senderId: string;
  senderRole: UserRole;
  body: string;
  createdAt: Date;
  sender: { id: string; name: string } | null;
}

export interface PaymentResult {
  payment: SerializedPayment;
  message: MessageWithSender | null;
  question: Question | null;
  questions: Question[] | null;
  bookings: Booking[] | null;
}

export function serializePayment(payment: {
  id: string;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  purpose: PaymentFor;
  providerOrderId?: string | null;
  clientDetails?: unknown;
}): SerializedPayment {
  return {
    id: payment.id,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    status: payment.status,
    provider: payment.provider,
    purpose: payment.purpose,
    ...(payment.providerOrderId ? { providerOrderId: payment.providerOrderId } : {}),
    ...(payment.clientDetails ? { clientDetails: payment.clientDetails } : {}),
  };
}

async function withSender(message: {
  id: string;
  senderId: string;
  senderRole: UserRole;
  body: string;
  createdAt: Date;
}): Promise<MessageWithSender> {
  const sender = await db.user.findUnique({
    where: { id: message.senderId },
    select: { id: true, name: true },
  });
  return { ...message, sender };
}

type PaymentWithIncluded = {
  id: string;
  payerId: string;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  purpose: PaymentFor;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  questionId: string | null;
  messageBody: string | null;
  clientDetails: unknown;
  paidMessages: { id: string; senderId: string; senderRole: UserRole; body: string; createdAt: Date }[];
};

/** Read description of the outcome already attached to a payment (no writes). */
export async function describePayment(
  paymentId: string
): Promise<PaymentResult | null> {
  const payment = await loadPayment(paymentId);
  if (!payment) return null;
  return describeLoadedPayment(payment);
}

async function loadPayment(paymentId: string): Promise<PaymentWithIncluded | null> {
  return db.payment.findUnique({
    where: { id: paymentId },
    include: { paidMessages: { take: 1 } },
  });
}

async function describeLoadedPayment(payment: PaymentWithIncluded): Promise<PaymentResult> {
  const base: PaymentResult = {
    payment: serializePayment(payment),
    message: null,
    question: null,
    questions: null,
    bookings: null,
  };

  if (payment.purpose === PaymentFor.Booking) {
    const bookings = await db.booking.findMany({ where: { paymentId: payment.id } });
    return { ...base, bookings };
  }

  if (payment.messageBody) {
    const question = payment.questionId
      ? await db.question.findUnique({ where: { id: payment.questionId } })
      : null;
    const message = payment.paidMessages[0] ? await withSender(payment.paidMessages[0]) : null;
    return { ...base, question, message };
  }

  const questions = await db.question.findMany({ where: { paymentId: payment.id } });
  return { ...base, questions };
}

export interface SettleOutcome extends PaymentResult {
  conflict: boolean;
}

/**
 * Settle a payment. Idempotent: an already-Succeeded (or otherwise final)
 * payment is just described and returned. `conflict` is true only when a
 * booking slot was lost between intent creation and settlement.
 */
export async function settlePayment(
  paymentId: string,
  providerPaymentId: string
): Promise<SettleOutcome | null> {
  const payment = await loadPayment(paymentId);
  if (!payment) return null;

  if (payment.status !== PaymentStatus.Created) {
    return { ...(await describeLoadedPayment(payment)), conflict: false };
  }

  if (payment.purpose !== PaymentFor.Booking && payment.purpose !== PaymentFor.Question) {
    return { ...(await describeLoadedPayment(payment)), conflict: false };
  }

  if (payment.purpose === PaymentFor.Booking) {
    return settleBooking(payment, providerPaymentId);
  }
  return settleQuestion(payment, providerPaymentId);
}

async function settleBooking(
  payment: PaymentWithIncluded,
  providerPaymentId: string
): Promise<SettleOutcome> {
  const claimedBookings = await db.booking.findMany({
    where: { paymentId: payment.id, status: BookingStatus.PendingPayment },
  });

  let settled: Awaited<ReturnType<typeof runSettleBooking>>;
  try {
    settled = await runSettleBooking(payment, claimedBookings, providerPaymentId);
  } catch (err) {
    // The bookings_no_overlap exclusion constraint fired: another booking was
    // confirmed for this slot while we were settling (a writer that does not
    // take the advisory lock, or a concurrent settlement that beat us to it).
    if (isSlotOverlapError(err)) {
      await failCreatedPayment(payment.id);
      return {
        payment: serializePayment({ ...payment, status: PaymentStatus.Failed }),
        message: null,
        question: null,
        questions: null,
        bookings: [],
        conflict: true,
      };
    }
    throw err;
  }

  if (settled.conflict) {
    return {
      payment: serializePayment({ ...payment, status: PaymentStatus.Failed }),
      message: null,
      question: null,
      questions: null,
      bookings: [],
      conflict: true,
    };
  }

  return {
    payment: serializePayment(settled.updatedPayment),
    message: null,
    question: null,
    questions: null,
    bookings: settled.settledBookings,
    conflict: false,
  };
}

async function runSettleBooking(
  payment: PaymentWithIncluded,
  claimedBookings: Booking[],
  providerPaymentId: string
) {
  return db.$transaction(async (tx) => {
    // Serialize against every other booking write for these astrologers, so
    // the clash check and the confirm step cannot interleave with another
    // create/reschedule/settle for the same slot.
    const astrologerIds = [...new Set(claimedBookings.map((b) => b.astrologerId))].sort();
    for (const astrologerId of astrologerIds) {
      await lockAstrologerBookings(tx, astrologerId);
    }

    for (const booking of claimedBookings) {
      const clash = await tx.booking.findFirst({
        where: {
          id: { not: booking.id },
          astrologerId: booking.astrologerId,
          startAt: { lt: booking.endAt },
          endAt: { gt: booking.startAt },
          // Settled bookings and other clients' live checkout holds both
          // mean this slot is gone: the payer either loses the race (their
          // payment is failed and their own hold released below) or wins it.
          ...slotClaimWhere(),
        },
      });
      if (clash) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.Failed },
        });
        await releaseHolds(tx, payment.id);
        return { conflict: true as const };
      }
    }

    // Confirm the booking before the money is marked taken: if it was
    // cancelled while the payer stood at the gateway, there is no session to
    // charge for, so the payment is failed (and refunded) instead.
    await tx.booking.updateMany({
      where: { paymentId: payment.id, status: BookingStatus.PendingPayment },
      data: { status: BookingStatus.Confirmed, holdExpiresAt: null },
    });
    const settledBookings = await tx.booking.findMany({ where: { paymentId: payment.id } });
    const hasLiveBooking = settledBookings.some(
      (b) =>
        b.status === BookingStatus.Confirmed || b.status === BookingStatus.Rescheduled
    );
    if (!hasLiveBooking) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.Failed },
      });
      await releaseHolds(tx, payment.id);
      return { conflict: true as const };
    }

    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.Succeeded, providerPaymentId },
    });
    return { conflict: false as const, updatedPayment, settledBookings };
  });
}

/**
 * Free the checkout holds a payment was keeping alive, so the slot becomes
 * bookable again immediately instead of only after the hold's TTL runs out.
 * Works with both the shared client and a transaction client.
 */
async function releaseHolds(
  tx: Pick<Prisma.TransactionClient, "booking">,
  paymentId: string
): Promise<void> {
  await tx.booking.updateMany({
    where: { paymentId, status: BookingStatus.PendingPayment },
    data: { holdExpiresAt: new Date() },
  });
}

/**
 * Fail a payment that lost its slot outside a transaction (used when the
 * exclusion constraint rolled the settling transaction back) and release the
 * holds it carried. Only a payment still in Created is touched, so a
 * concurrently settled payment is left alone.
 */
async function failCreatedPayment(paymentId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const failed = await tx.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.Created },
      data: { status: PaymentStatus.Failed },
    });
    if (failed.count > 0) {
      await releaseHolds(tx, paymentId);
    }
  });
}

async function settleQuestion(
  payment: PaymentWithIncluded,
  providerPaymentId: string
): Promise<SettleOutcome> {
  // Batch question purchase: the covering payment carries no message body, and
  // settling it activates every pending question pointing at it at once.
  if (!payment.messageBody) {
    const settled = await db.$transaction(async (tx) => {
      // Claim the payment transition conditionally so two concurrent
      // settlements cannot both run: the loser matches zero rows and returns
      // the winner's outcome below instead of activating questions twice.
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.Created },
        data: { status: PaymentStatus.Succeeded, providerPaymentId },
      });
      if (claimed.count === 0) return null;

      await tx.question.updateMany({
        where: { paymentId: payment.id, status: QuestionStatus.PendingPayment },
        data: { status: QuestionStatus.Queued },
      });
      const settledQuestions = await tx.question.findMany({ where: { paymentId: payment.id } });
      return { settledQuestions };
    });

    if (!settled) {
      return raceLoserOutcome(payment);
    }

    await Promise.all(settled.settledQuestions.map((q) => broadcastQuestionUpdate(q.id)));

    const updatedPayment = await db.payment.findUnique({ where: { id: payment.id } });

    return {
      payment: serializePayment(updatedPayment ?? payment),
      message: null,
      question: null,
      questions: settled.settledQuestions,
      bookings: null,
      conflict: false,
    };
  }

  if (!payment.questionId) {
    throw new Error("Payment is missing question message data");
  }

  // Resolve the payer's side by question ownership rather than by role, so an
  // astrologer who also uses the product as a customer is recorded as the
  // client on questions they asked. Matches the logic in POST /questions/:id/messages.
  const [question, payerProfile] = await Promise.all([
    db.question.findUnique({
      where: { id: payment.questionId },
      select: { id: true, clientId: true, astrologerId: true },
    }),
    db.astrologerProfile.findUnique({
      where: { userId: payment.payerId },
      select: { id: true },
    }),
  ]);
  if (!question) throw new Error("Payment question not found");

  const isClientSide = question.clientId === payment.payerId;
  const isAstrologerSide =
    payerProfile !== null && question.astrologerId === payerProfile.id;
  const senderRole = isClientSide
    ? UserRole.Client
    : isAstrologerSide
      ? UserRole.Astrologer
      : UserRole.Client;

  const settled = await db.$transaction(async (tx) => {
    // Same conditional claim as the batch branch above: at most one of two
    // concurrent settlements gets to deliver the paid message.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.Created },
      data: { status: PaymentStatus.Succeeded, providerPaymentId },
    });
    if (claimed.count === 0) return null;

    const message = await tx.questionMessage.create({
      data: {
        questionId: payment.questionId!,
        senderId: payment.payerId,
        senderRole,
        body: payment.messageBody!,
        paymentId: payment.id,
      },
    });

    let question = payment.questionId
      ? await tx.question.findUnique({ where: { id: payment.questionId } })
      : null;
    if (question && question.status === QuestionStatus.PendingPayment) {
      question = await tx.question.update({
        where: { id: question.id },
        data: { status: QuestionStatus.Queued },
      });
    }

    return { message, question };
  });
  if (!settled) {
    return raceLoserOutcome(payment);
  }

  const message = await withSender(settled.message);
  if (settled.message.questionId) {
    await Promise.all([
      broadcastMessage(settled.message.questionId, settled.message.id),
      broadcastQuestionUpdate(settled.message.questionId),
    ]);
  }

  const updatedPayment = await db.payment.findUnique({ where: { id: payment.id } });

  return {
    payment: serializePayment(updatedPayment ?? payment),
    message,
    question: settled.question,
    questions: null,
    bookings: null,
    conflict: false,
  };
}

/**
 * Outcome when a settle lost the race to a concurrent settlement: the payment
 * is already final, so describe its current state instead of replaying it.
 */
async function raceLoserOutcome(payment: PaymentWithIncluded): Promise<SettleOutcome> {
  const current = await loadPayment(payment.id);
  if (!current) {
    return {
      payment: serializePayment(payment),
      message: null,
      question: null,
      questions: null,
      bookings: null,
      conflict: false,
    };
  }
  return { ...(await describeLoadedPayment(current)), conflict: false };
}

/** Mark a payment Failed (used when the gateway reports a non-payment). */
export async function markPaymentFailed(paymentId: string): Promise<SerializedPayment | null> {
  const payment = await loadPayment(paymentId);
  if (!payment) return null;
  if (payment.status !== PaymentStatus.Created) {
    return serializePayment(payment);
  }
  const updated = await db.payment.update({
    where: { id: paymentId },
    data: { status: PaymentStatus.Failed },
  });
  // A failed payment will never confirm its booking, so drop the checkout
  // hold right away and give the slot back to everyone.
  await releaseHolds(db, paymentId);
  return serializePayment(updated);
}

/**
 * Refuse to create a booking's gateway order if its slot was already lost to
 * someone else: there is no point sending the payer to a payment page they
 * cannot win, and it avoids a captured-then-refunded payment. Runs the same
 * clash check the settlement does (under the per-astrologer lock) and, when
 * the slot is gone, fails the intent and releases its holds immediately.
 *
 * Returns true when the booking can still go ahead for a booking payment, or
 * when the payment is not a booking settlement (nothing to check).
 */
export async function ensureBookingSlotClaimable(paymentId: string): Promise<boolean> {
  const payment = await loadPayment(paymentId);
  if (!payment) return false;
  if (payment.purpose !== PaymentFor.Booking) return true;

  const claimedBookings = await db.booking.findMany({
    where: { paymentId: payment.id, status: BookingStatus.PendingPayment },
  });
  // Nothing left to claim (cancelled, reaped, already settled) means heading
  // to the gateway would just end in a refund, so treat it as lost.
  if (claimedBookings.length === 0) return false;

  const lost = await db.$transaction(async (tx) => {
    const astrologerIds = [...new Set(claimedBookings.map((b) => b.astrologerId))].sort();
    for (const astrologerId of astrologerIds) {
      await lockAstrologerBookings(tx, astrologerId);
    }
    for (const booking of claimedBookings) {
      const clash = await tx.booking.findFirst({
        where: {
          id: { not: booking.id },
          astrologerId: booking.astrologerId,
          startAt: { lt: booking.endAt },
          endAt: { gt: booking.startAt },
          ...slotClaimWhere(),
        },
      });
      if (clash) return true;
    }
    return false;
  });

  if (lost) {
    await failCreatedPayment(payment.id);
  }
  return !lost;
}

/**
 * How long an abandoned checkout may sit around before it is cleaned up:
 * its hold expired (10 minutes after the last attempt) and a full day has
 * passed since then, so nobody is coming back to pay for it.
 */
export const ABANDONED_CHECKOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Reap abandoned checkouts: PendingPayment bookings whose hold expired more
 * than ABANDONED_CHECKOUT_MS ago are cancelled and their still-Created
 * intents failed, so the client's booking list stays honest and no dead
 * payment intent lingers. Expired holds already stopped blocking the slot -
 * this is purely housekeeping. The status-guarded updateMany makes it safe
 * to run concurrently with a settlement or a cancel: whoever gets there
 * first wins, the loser matches zero rows.
 *
 * Returns how many bookings were reaped.
 */
export async function reapAbandonedCheckouts(): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_CHECKOUT_MS);
  const abandoned = await db.booking.findMany({
    where: {
      status: BookingStatus.PendingPayment,
      OR: [
        { holdExpiresAt: { lt: cutoff } },
        // Legacy pendings written before holds existed never block, but an
        // equally old one is just as abandoned.
        { holdExpiresAt: null, createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true, paymentId: true },
  });
  if (abandoned.length === 0) return 0;

  return db.$transaction(async (tx) => {
    const reaped = await tx.booking.updateMany({
      where: { id: { in: abandoned.map((b) => b.id) }, status: BookingStatus.PendingPayment },
      data: {
        status: BookingStatus.CancelledByClient,
        cancellationReason: "Checkout abandoned - payment not completed",
      },
    });
    const paymentIds = [
      ...new Set(abandoned.map((b) => b.paymentId).filter((id): id is string => id !== null)),
    ];
    if (paymentIds.length > 0) {
      await tx.payment.updateMany({
        where: { id: { in: paymentIds }, status: PaymentStatus.Created },
        data: { status: PaymentStatus.Failed },
      });
    }
    return reaped.count;
  });
}