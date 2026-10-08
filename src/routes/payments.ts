import { Router, urlencoded, type Request, type Response } from "express";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { paramString } from "../lib/http";
import { PaymentFor, PaymentStatus } from "@prisma/client";
import {
  getPhonePeConfig,
  phonePeBaseUrl,
  initiatePayment,
  checkPaymentStatus,
  verifyWebhookSignature,
  webhookStateOf,
  webhookTransactionIdOf,
  type PhonePeWebhook,
} from "../lib/phonepe";
import {
  describePayment,
  settlePayment,
  markPaymentFailed,
  serializePayment,
  ensureBookingSlotClaimable,
} from "../lib/settlement";
import { z } from "zod";

const router = Router();

const initiateSchema = z.object({
  returnTo: z.string().url().optional(),
});

const ALLOWED_RETURN_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:5173",
  "http://localhost:8081",
  "http://10.89.21.117:3001",
  "http://10.89.21.117:3002",
];

function isAllowedReturnUrl(target: string, apiBase: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const allowed = new Set<string>(ALLOWED_RETURN_ORIGINS.map((o) => new URL(o).host));
  allowed.add(new URL(apiBase).host);
  allowed.add(new URL(phonePeBaseUrl()).host);
  for (const origin of (process.env.PHONEPE_RETURN_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = origin.trim();
    if (trimmed) {
      try {
        allowed.add(new URL(trimmed).host);
      } catch {
        // ignore malformed origins
      }
    }
  }
  return allowed.has(url.host);
}

function appendSearch(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

/** First non-empty query param among the candidate names (length-safe). */
function firstQueryParam(req: Request, names: string[]): string | undefined {
  for (const name of names) {
    const value = req.query[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * @openapi
 * /payments/{paymentId}/initiate:
 *   post:
 *     tags: [Payments]
 *     summary: Open a gateway checkout for a payment intent (PhonePe Standard
 *       Checkout v2). For mock payments this returns mode "mock" so the client
 *       keeps using /complete. Returns a redirectUrl the browser should navigate
 *       to; the user comes back via /payments/phonepe/return.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               returnTo:
 *                 type: string
 *                 description: Frontend URL to send the user back to after paying
 *     responses:
 *       200: { description: Checkout initiated }
 *       403: { description: Not the payer }
 *       404: { description: Payment not found }
 *       503: { description: PhonePe not configured }
 */
router.post("/:paymentId/initiate", requireAuth, async (req, res) => {
  try {
    const id = paramString(req.params.paymentId);
    if (!id) return res.status(404).json({ error: "Payment not found" });

    const payment = await db.payment.findUnique({ where: { id } });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.payerId !== req.user!.id) {
      return res.status(403).json({ error: "Only the payer can initiate this payment" });
    }

    const cfg = getPhonePeConfig();
    const gatewayMode = cfg.enabled;

    // Already final: return the settled outcome so the client can finish up
    // without another gateway round-trip.
    if (payment.status !== PaymentStatus.Created) {
      const outcome = await describePayment(payment.id);
      return res.json({ mode: gatewayMode ? "gateway" : "mock", redirectUrl: null, ...outcome });
    }

    // PhonePe not configured: keep the local mock completion flow.
    if (!gatewayMode) {
      return res.json({ mode: "mock", redirectUrl: null, payment: serializePayment(payment) });
    }

    const parsed = initiateSchema.safeParse(req.body ?? {});
    const returnTo = parsed.success ? parsed.data.returnTo : undefined;
    if (returnTo && !isAllowedReturnUrl(returnTo, cfg.gatewayBase)) {
      return res.status(400).json({ error: "Invalid return URL" });
    }

    // Don't send the payer to a payment page they cannot win: when the slot
    // was already lost to someone else (or the checkout was cancelled), fail
    // the intent here so no gateway order is created - and no money taken -
    // in the first place.
    if (!(await ensureBookingSlotClaimable(payment.id))) {
      return res.status(409).json({ error: "Slot is no longer available" });
    }

    const base = phonePeBaseUrl();
    const payer = await db.user.findUnique({
      where: { id: payment.payerId },
      select: { mobile: true },
    });
    const result = await initiatePayment({
      paymentId: payment.id,
      amountPaise: payment.amountPaise,
      merchantUserId: payment.payerId,
      redirectUrl: `${base}/payments/phonepe/return?paymentId=${encodeURIComponent(payment.id)}`,
      phoneNumber: payer?.mobile ?? undefined,
    });

    const clientDetails = {
      ...(typeof payment.clientDetails === "object" && payment.clientDetails !== null
        ? (payment.clientDetails as Record<string, unknown>)
        : {}),
      ...(returnTo ? { returnTo } : {}),
      orderId: result.orderId,
    };

    // Upgrade the intent to the real provider once it goes through the gateway.
    const updated = await db.payment.update({
      where: { id: payment.id },
      data: {
        provider: "phonepe",
        providerOrderId: result.merchantOrderId,
        clientDetails,
      },
    });

    return res.json({
      mode: "gateway",
      redirectUrl: result.redirectUrl,
      payment: serializePayment(updated),
    });
  } catch (err) {
    console.error("Initiate payment error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
});

/**
 * @openapi
 * /payments/{paymentId}:
 *   get:
 *     tags: [Payments]
 *     summary: Read the current outcome of a payment (used to poll after the
 *       user returns from the gateway).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Payment outcome }
 *       403: { description: Not the payer }
 *       404: { description: Payment not found }
 */
router.get("/:paymentId", requireAuth, async (req, res) => {
  try {
    const id = paramString(req.params.paymentId);
    if (!id) return res.status(404).json({ error: "Payment not found" });

    const payment = await db.payment.findUnique({ where: { id } });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.payerId !== req.user!.id) {
      return res.status(403).json({ error: "Only the payer can read this payment" });
    }

    const outcome = await describePayment(payment.id);
    return res.json(outcome);
  } catch (err) {
    console.error("Read payment error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /payments/{paymentId}/complete:
 *   post:
 *     tags: [Payments]
 *     summary: Complete a mock payment (the old local settlement path). Only
 *       valid for provider "mock"; PhonePe payments settle via webhook/return.
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

    const payment = await db.payment.findUnique({ where: { id } });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.payerId !== req.user!.id) {
      return res.status(403).json({ error: "Only the payer can complete this payment" });
    }
    if (payment.provider !== "mock") {
      return res.status(409).json({ error: "This payment settles through the payment gateway" });
    }
    if (payment.purpose !== PaymentFor.Booking && payment.purpose !== PaymentFor.Question) {
      return res.status(409).json({ error: "This payment cannot be settled this way" });
    }

    const outcome = await settlePayment(payment.id, `mock_${payment.id}`);
    if (!outcome) return res.status(404).json({ error: "Payment not found" });

    if (outcome.conflict) {
      return res.status(409).json({ error: "Slot is no longer available" });
    }

    return res.json({
      payment: outcome.payment,
      message: outcome.message,
      question: outcome.question,
      questions: outcome.questions,
      bookings: outcome.bookings,
    });
  } catch (err) {
    console.error("Complete payment error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /payments/webhook:
 *   post:
 *     tags: [Payments]
 *     summary: PhonePe callback webhook (v2). Settles payments reported by the
 *       gateway. Verification is optional (configured in the PhonePe dashboard);
 *       see PHONEPE_WEBHOOK_SECRET / PHONEPE_WEBHOOK_USERNAME / _PASSWORD.
 *     responses:
 *       200: { description: Acknowledged }
 *       400: { description: Malformed payload }
 *       401: { description: Bad signature }
 *       500: { description: Internal server error }
 */
router.post("/webhook", async (req, res) => {
  try {
    const cfg = getPhonePeConfig();
    if (!cfg.enabled) {
      return res.status(503).json({ error: "PhonePe payment is not configured" });
    }

    const rawBody = (req as { rawBody?: Buffer }).rawBody;
    const bodyString = rawBody ? rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
    if (!verifyWebhookSignature(bodyString, req.headers)) {
      return res.status(401).json({ success: false, code: "SIGNATURE_MISMATCH" });
    }

    const envelope = req.body as PhonePeWebhook;
    if (!envelope?.payload || typeof envelope.payload !== "object") {
      return res.status(400).json({ success: false, code: "BAD_REQUEST" });
    }
    const merchantOrderId = envelope.payload.merchantOrderId;
    if (typeof merchantOrderId !== "string" || !merchantOrderId) {
      return res.status(400).json({ success: false, code: "BAD_REQUEST" });
    }

    const payment = await db.payment.findFirst({
      where: { providerOrderId: merchantOrderId },
    });
    if (!payment) {
      return res
        .status(200)
        .json({ success: false, code: "UNKNOWN_MERCHANT_TRANSACTION_ID" });
    }

    await db.payment.update({
      where: { id: payment.id },
      data: { rawWebhookPayload: req.body as object },
    });

    const paymentState = webhookStateOf(envelope);
    const transactionId = webhookTransactionIdOf(envelope) ?? merchantOrderId;

    if (paymentState === "COMPLETED") {
      await settlePayment(payment.id, transactionId);
    } else if (paymentState === "FAILED") {
      await markPaymentFailed(payment.id);
    }
    // PENDING or unknown: leave the intent Created; the return/status path or a
    // later callback will settle it.

    return res.json({ success: true, code: "PAYMENT_SUCCESS" });
  } catch (err) {
    console.error("Payment webhook error:", err);
    return res.status(500).json({ success: false, code: "PAYMENT_ERROR" });
  }
});

/**
 * @openapi
 * /payments/phonepe/return:
 *   post:
 *     tags: [Payments]
 *     summary: Target of the PhonePe redirect (also handles GET). Best-effort
 *       settles the payment from the gateway status, then ALWAYS sends the
 *       browser back to the frontend with ?paymentId=...&status=success|failed|
 *       pending so the page can show the correct result without getting stuck.
 *     responses:
 *       302: { description: Redirect back to the frontend }
 */
async function handleGatewayReturn(req: Request, res: Response) {
  const fallback = process.env.PHONEPE_RETURN_FALLBACK_URL ?? "http://localhost:3002";
  try {
    const paymentId =
      (req.body?.paymentId as string | undefined) ?? firstQueryParam(req, ["paymentId"]);
    const merchantOrderId =
      (req.body?.merchantOrderId as string | undefined) ?? firstQueryParam(req, ["merchantOrderId"]);

    // Resolve the payment by id first (we embed it in the redirectUrl ahead of
    // time), then fall back to the gateway's merchant order id.
    let payment = paymentId
      ? await db.payment.findUnique({ where: { id: paymentId } })
      : null;
    if (!payment && merchantOrderId) {
      payment = await db.payment.findFirst({ where: { providerOrderId: merchantOrderId } });
    }

    if (!payment) {
      // Unknown return: never strand the user on the gateway page.
      return res.redirect(302, appendSearch(fallback, "status", "error"));
    }

    // Best-effort reconciliation against the gateway. A failed status call must
    // not block the redirect: fall back to whatever state we already know
    // (a webhook may have settled the payment while the user was paying).
    let returnStatus: "success" | "failed" | "pending" = "pending";
    if (merchantOrderId) {
      try {
        const status = await checkPaymentStatus(merchantOrderId);
        if (status.paymentState === "COMPLETED") {
          await settlePayment(payment.id, status.transactionId ?? merchantOrderId);
          returnStatus = "success";
        } else if (status.paymentState === "FAILED") {
          await markPaymentFailed(payment.id);
          returnStatus = "failed";
        }
      } catch (err) {
        console.warn("PhonePe return: gateway status unavailable, using stored state:", err);
      }
    }

    const stored = await db.payment.findUnique({
      where: { id: payment.id },
      select: { status: true },
    });
    if (returnStatus === "pending" && stored) {
      if (stored.status === PaymentStatus.Succeeded) returnStatus = "success";
      else if (stored.status === PaymentStatus.Failed) returnStatus = "failed";
    }

    const returnTo =
      typeof payment.clientDetails === "object" && payment.clientDetails !== null
        ? (payment.clientDetails as Record<string, unknown>).returnTo
        : undefined;
    const validReturn =
      typeof returnTo === "string" && returnTo
        ? isAllowedReturnUrl(returnTo, getPhonePeConfig().gatewayBase)
        : false;
    const target = appendSearch(
      validReturn ? (returnTo as string) : fallback,
      "paymentId",
      payment.id
    );
    return res.redirect(302, appendSearch(target, "status", returnStatus));
  } catch (err) {
    console.error("PhonePe return error:", err);
    return res.redirect(302, appendSearch(fallback, "status", "error"));
  }
}

router.get("/phonepe/return", handleGatewayReturn);
router.post("/phonepe/return", urlencoded({ extended: false }), handleGatewayReturn);

export default router;