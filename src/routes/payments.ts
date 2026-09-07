import { Router } from "express";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { paramString } from "../lib/http";
import { PaymentFor, PaymentStatus, QuestionStatus, UserRole } from "@prisma/client";

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
    if (payment.purpose !== PaymentFor.Question) {
      return res.status(409).json({ error: "This payment cannot be settled this way" });
    }

    // Idempotent: an already-settled payment just returns the delivered message.
    if (payment.status === PaymentStatus.Succeeded) {
      const message = payment.paidMessages[0] ?? null;
      return res.json({
        payment: serializePayment(payment),
        message: message ? await withSender(message) : null,
        question,
      });
    }

    if (payment.status !== PaymentStatus.Created) {
      return res.status(409).json({ error: "Payment is not in a completable state" });
    }
    if (!payment.questionId || !payment.messageBody) {
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
    return res.json({
      payment: serializePayment(settled.updatedPayment),
      message,
      question: settled.question,
    });
  } catch (err) {
    console.error("Complete payment error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

function serializePayment(payment: { id: string; amountPaise: number; currency: string; status: PaymentStatus; provider: string }) {
  return {
    id: payment.id,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    status: payment.status,
    provider: payment.provider,
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