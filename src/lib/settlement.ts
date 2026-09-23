import { db } from "../../prisma/db";
import {
  BookingStatus,
  PaymentFor,
  PaymentStatus,
  QuestionStatus,
  UserRole,
  type Booking,
  type Question,
} from "@prisma/client";
import { broadcastMessage, broadcastQuestionUpdate } from "./realtime";

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

  const settled = await db.$transaction(async (tx) => {
    for (const booking of claimedBookings) {
      const clash = await tx.booking.findFirst({
        where: {
          id: { not: booking.id },
          astrologerId: booking.astrologerId,
          status: { in: [BookingStatus.Confirmed, BookingStatus.Rescheduled] },
          startAt: { lt: booking.endAt },
          endAt: { gt: booking.startAt },
        },
      });
      if (clash) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.Failed },
        });
        return { conflict: true as const };
      }
    }

    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.Succeeded, providerPaymentId },
    });
    await tx.booking.updateMany({
      where: { paymentId: payment.id, status: BookingStatus.PendingPayment },
      data: { status: BookingStatus.Confirmed },
    });
    const settledBookings = await tx.booking.findMany({ where: { paymentId: payment.id } });
    return { conflict: false as const, updatedPayment, settledBookings };
  });

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

async function settleQuestion(
  payment: PaymentWithIncluded,
  providerPaymentId: string
): Promise<SettleOutcome> {
  // Batch question purchase: the covering payment carries no message body, and
  // settling it activates every pending question pointing at it at once.
  if (!payment.messageBody) {
    const settled = await db.$transaction(async (tx) => {
      await tx.question.updateMany({
        where: { paymentId: payment.id, status: QuestionStatus.PendingPayment },
        data: { status: QuestionStatus.Queued },
      });
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.Succeeded, providerPaymentId },
      });
      const settledQuestions = await tx.question.findMany({ where: { paymentId: payment.id } });
      return { settledQuestions, updatedPayment };
    });

    await Promise.all(settled.settledQuestions.map((q) => broadcastQuestionUpdate(q.id)));

    return {
      payment: serializePayment(settled.updatedPayment),
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

  const payer = await db.user.findUnique({
    where: { id: payment.payerId },
    select: { role: true },
  });

  const settled = await db.$transaction(async (tx) => {
    const message = await tx.questionMessage.create({
      data: {
        questionId: payment.questionId!,
        senderId: payment.payerId,
        senderRole:
          payer?.role === UserRole.Astrologer ? UserRole.Astrologer : UserRole.Client,
        body: payment.messageBody!,
        paymentId: payment.id,
      },
    });

    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.Succeeded, providerPaymentId },
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

    return { message, updatedPayment, question };
  });

  const message = await withSender(settled.message);
  if (settled.message.questionId) {
    await Promise.all([
      broadcastMessage(settled.message.questionId, settled.message.id),
      broadcastQuestionUpdate(settled.message.questionId),
    ]);
  }

  return {
    payment: serializePayment(settled.updatedPayment),
    message,
    question: settled.question,
    questions: null,
    bookings: null,
    conflict: false,
  };
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
  return serializePayment(updated);
}