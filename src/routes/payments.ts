import { Router } from "express";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { paramString } from "../lib/http";
import { broadcastMessage, broadcastQuestionUpdate } from "../lib/realtime";
import { PaymentFor, PaymentStatus, BookingStatus, QuestionStatus, UserRole } from "@prisma/client";

const router = Router();

/**
 * @openapi
 * /payments/{paymentId}/complete:
 *   post:
 *     tags: [Payments]
 *     summary: Complete a question payment (mock provider settlement). This is
 *       what turns a client's pending payment intent into a paid chat message.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Payment settled and message delivered }
 *       401: { description: Unauthorized }
 *       403: { description: Not the payer }
 *       404: { description: Payment not found }
 *       409: { description: Payment cannot be completed in its current state }
 *       500: { description: Internal server error }
 */
router.post("/:paymentId/complete", requireAuth, async (req, res) => {
  try {
    const id = paramString(req.params.paymentId);
    if (!id) return res.status(404).json({ error: "Payment not found" });

    const payment = await db.payment.findUnique({
      where: { id },
      include: {
        paidMessages: { take: 1 },
      },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    const question = payment.questionId
      ? await db.question.findUnique({ where: { id: payment.questionId } })
      : null;

    const userId = req.user!.id;
    if (payment.payerId !== userId) {
      return res.status(403).json({ error: "Only the payer can complete this payment" });
    }

    // Booking payment: settling confirms the linked booking(s) for the slot.
    if (payment.purpose === PaymentFor.Booking) {
      if (payment.status === PaymentStatus.Succeeded) {
        const settledBookings = await db.booking.findMany({ where: { paymentId: payment.id } });
        return res.json({
          payment: serializePayment(payment),
          message: null,
          question: null,
          questions: null,
          bookings: settledBookings,
        });
      }
      if (payment.status !== PaymentStatus.Created) {
        return res.status(409).json({ error: "Payment is not in a completable state" });
      }

      const claimedBookings = await db.booking.findMany({
        where: { paymentId: payment.id, status: BookingStatus.PendingPayment },
      });

      const settled = await db.$transaction(async (tx) => {
        // A slot is only reserved once payment settles, so re-check for a
        // competing confirmation before claiming it.
        for (const booking of claimedBookings) {
          const clash = await tx.booking.findFirst({
            where: {
              id: { not: booking.id },
              astrologerId: booking.astrologerId,
              status: {
                in: [BookingStatus.Confirmed, BookingStatus.Rescheduled],
              },
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
          data: {
            status: PaymentStatus.Succeeded,
            providerPaymentId: `mock_${payment.id}`,
          },
        });
        await tx.booking.updateMany({
          where: { paymentId: payment.id, status: BookingStatus.PendingPayment },
          data: { status: BookingStatus.Confirmed },
        });
        const settledBookings = await tx.booking.findMany({ where: { paymentId: payment.id } });
        return { conflict: false as const, updatedPayment, settledBookings };
      });

      if (settled.conflict) {
        return res.status(409).json({ error: "Slot is no longer available" });
      }

      return res.json({
        payment: serializePayment(settled.updatedPayment),
        message: null,
        question: null,
        questions: null,
        bookings: settled.settledBookings,
      });
    }

    if (payment.purpose !== PaymentFor.Question) {
      return res.status(409).json({ error: "This payment cannot be settled this way" });
    }

    // Idempotent: an already-settled payment just returns the delivered result.
    if (payment.status === PaymentStatus.Succeeded) {
      if (payment.messageBody) {
        const message = payment.paidMessages[0] ?? null;
        return res.json({
          payment: serializePayment(payment),
          message: message ? await withSender(message) : null,
          question,
          questions: null,
        });
      }
      // Batch question purchase (no chat message): return the paid questions.
      const settledQuestions = await db.question.findMany({
        where: { paymentId: payment.id },
      });
      return res.json({
        payment: serializePayment(payment),
        message: null,
        question: null,
        questions: settledQuestions,
      });
    }

    if (payment.status !== PaymentStatus.Created) {
      return res.status(409).json({ error: "Payment is not in a completable state" });
    }

    // Batch question purchase: the covering payment carries no message body.
    // Settling it activates every question that points at the payment at once.
    if (!payment.messageBody) {
      const settled = await db.$transaction(async (tx) => {
        await tx.question.updateMany({
          where: { paymentId: payment.id, status: QuestionStatus.PendingPayment },
          data: { status: QuestionStatus.Queued },
        });
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.Succeeded,
            providerPaymentId: `mock_${payment.id}`,
          },
        });
        const settledQuestions = await tx.question.findMany({
          where: { paymentId: payment.id },
        });
        return { settledQuestions, updatedPayment };
      });

      await Promise.all(settled.settledQuestions.map((q) => broadcastQuestionUpdate(q.id)));

      return res.json({
        payment: serializePayment(settled.updatedPayment),
        message: null,
        question: null,
        questions: settled.settledQuestions,
      });
    }

    if (!payment.questionId) {
      return res.status(409).json({ error: "Payment is missing question message data" });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) return res.status(401).json({ error: "User not found" });

    const settled = await db.$transaction(async (tx) => {
      const message = await tx.questionMessage.create({
        data: {
          questionId: payment.questionId!,
          senderId: userId,
          senderRole: user.role === UserRole.Astrologer ? UserRole.Astrologer : UserRole.Client,
          body: payment.messageBody!,
          paymentId: payment.id,
        },
      });

      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.Succeeded,
          providerPaymentId: `mock_${payment.id}`,
        },
      });

      let q = question;
      if (q && q.status === QuestionStatus.PendingPayment) {
        q = await tx.question.update({
          where: { id: q.id },
          data: { status: QuestionStatus.Queued },
        });
      }

      return { message, updatedPayment, question: q };
    });

    const message = await withSender(settled.message);
    if (settled.message?.questionId) {
      await Promise.all([
        broadcastMessage(settled.message.questionId, settled.message.id),
        broadcastQuestionUpdate(settled.message.questionId),
      ]);
    }
    return res.json({
      payment: serializePayment(settled.updatedPayment),
      message,
      question: settled.question,
      questions: null,
    });
  } catch (err) {
    console.error("Complete payment error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

function serializePayment(payment: {
  id: string;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  clientDetails?: unknown;
}) {
  return {
    id: payment.id,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    status: payment.status,
    provider: payment.provider,
    ...(payment.clientDetails ? { clientDetails: payment.clientDetails } : {}),
  };
}

async function withSender(message: { id: string; senderId: string; senderRole: UserRole; body: string; createdAt: Date }) {
  const sender = await db.user.findUnique({
    where: { id: message.senderId },
    select: { id: true, name: true },
  });
  return { ...message, sender };
}

export default router;