import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { getBaseUrl, createAstrologer, json, registerUser, testEmail, uniqueUsername } from "./helpers";
import {
  merchantTransactionIdFor,
  activePaymentProvider,
  getPhonePeConfig,
  initiatePayment,
  checkPaymentStatus,
  verifyWebhookSignature,
  getAccessToken,
  resetPhonePeAuthCache,
} from "../src/lib/phonepe";

// Enable the PhonePe provider for these tests (config is read lazily).
process.env.PHONEPE_ENV = "sandbox";
process.env.PHONEPE_CLIENT_ID = "TESTCLIENT";
process.env.PHONEPE_CLIENT_VERSION = "1.0.0";
process.env.PHONEPE_CLIENT_SECRET = "0123456789abcdef";
process.env.PHONEPE_API_BASE_URL = "https://gateway.phonepe.example.test";
process.env.PHONEPE_AUTH_API_BASE_URL = "https://auth.phonepe.example.test";
process.env.PHONEPE_WEBHOOK_SECRET = "test-webhook-secret";

const WEBHOOK_SECRET = "test-webhook-secret";

let astrologer: Awaited<ReturnType<typeof createAstrologer>>;
let clientEmail = "";
let clientId = "";
let clientToken = "";

const base = getBaseUrl();

beforeAll(async () => {
  astrologer = await createAstrologer();
  clientEmail = testEmail("ppclient");
  const res = await registerUser({
    name: "PhonePe Client",
    email: clientEmail,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  clientToken = (await json<{ accessToken: string }>(res)).accessToken;
  const { db } = await import("../prisma/db");
  const user = await db.user.findUnique({ where: { email: clientEmail } });
  clientId = user!.id;
});

afterEach(() => {
  resetPhonePeAuthCache();
});

afterAll(async () => {
  const { db } = await import("../prisma/db");
  await removeUser(db, clientEmail);
  await removeUser(db, astrologer.creds.email);
});

async function removeUser(db: PrismaClient, email: string) {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return;
  const profile = await db.astrologerProfile.findUnique({ where: { userId: user.id } });
  if (profile) {
    await db.questionMessage.deleteMany({ where: { question: { astrologerId: profile.id } } });
    await db.question.deleteMany({ where: { astrologerId: profile.id } });
    await db.payment.deleteMany({ where: { payeeAstrologerId: profile.id } });
  }
  await db.questionMessage.deleteMany({ where: { question: { clientId: user.id } } });
  await db.question.deleteMany({ where: { clientId: user.id } });
  await db.payment.deleteMany({ where: { payerId: user.id } });
  await db.refreshToken.deleteMany({ where: { userId: user.id } });
  await db.astrologerProfile.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
}

// ------------------------------------------------------------- fetch mock --

const fetchDequeues: Response[] = [];
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function installFetchMock() {
  const real = globalThis.fetch;
  fetchCalls.length = 0;
  fetchDequeues.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    const next = fetchDequeues.shift();
    if (!next) throw new Error(`Unexpected fetch: ${String(input)}`);
    return next;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function authTokenResponse(expiresAt: number): Response {
  return jsonResponse(200, {
    access_token: "test-access-token",
    encrypted_access_token: "test-access-token",
    issued_at: Math.floor(Date.now() / 1000),
    expires_at: expiresAt,
    token_type: "O-Bearer",
  });
}

function signedWebhook(merchantOrderId: string, state: string, extra: Record<string, unknown> = {}) {
  const body = {
    event: state === "COMPLETED" ? "checkout.order.completed" : "checkout.order.failed",
    payload: {
      orderId: "OMO123456789",
      merchantId: "TESTCLIENT",
      merchantOrderId,
      state,
      amount: 4900,
      expireAt: 1724866793837,
      paymentDetails: [
        { paymentMode: "UPI_QR", transactionId: "T1234", timestamp: 1724866793837, amount: 4900, state },
      ],
      metaInfo: { udf1: "", udf2: "" },
      ...extra,
    },
  };
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return { body, signature };
}

async function postWebhook(body: unknown, signature?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature) headers["phonepe-checksum-signature"] = signature;
  return fetch(`${base}/payments/webhook`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function makePhonePeQuestionPayment(questionText: string) {
  const { db } = await import("../prisma/db");
  const paymentId = randomUUID();
  const merchantOrderId = merchantTransactionIdFor(paymentId);
  const payment = await db.payment.create({
    data: {
      id: paymentId,
      payerId: clientId,
      payeeAstrologerId: astrologer.profile.id,
      amountPaise: 4900,
      currency: "INR",
      provider: "phonepe",
      purpose: "Question",
      providerOrderId: merchantOrderId,
      status: "Created",
    },
  });
  const question = await db.question.create({
    data: {
      clientId,
      astrologerId: astrologer.profile.id,
      questionText,
      pricePaise: 4900,
      status: "PendingPayment",
      paymentId: payment.id,
    },
  });
  return { payment, question, merchantOrderId };
}

// ----------------------------------------------------------------- config --

describe("phonepe config", () => {
  test("merchantTransactionIdFor is deterministic and within v2 constraints", () => {
    const paymentId = randomUUID();
    const mid = merchantTransactionIdFor(paymentId);
    expect(mid).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(mid.length).toBeLessThanOrEqual(63);
    expect(merchantTransactionIdFor(paymentId)).toBe(mid);
  });

  test("activePaymentProvider reflects env config", () => {
    expect(activePaymentProvider()).toBe("phonepe");
  });

  test("getPhonePeConfig points at the v2 endpoints", () => {
    const cfg = getPhonePeConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.gatewayBase).toBe("https://gateway.phonepe.example.test");
    expect(cfg.authBase).toBe("https://auth.phonepe.example.test");
    expect(cfg.webhookSecret).toBe(WEBHOOK_SECRET);
  });
});

// ------------------------------------------------------------ oauth token --

describe("phonepe oauth token", () => {
  test("fetches and caches the O-Bearer token until near expiry", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));

      const first = await getAccessToken();
      expect(first).toBe("test-access-token");
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]!.url).toContain("/v1/oauth/token");
      expect(fetchCalls[0]!.init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });

      const again = await getAccessToken();
      expect(again).toBe("test-access-token");
      expect(fetchCalls.length).toBe(1);
    } finally {
      restore();
    }
  });

  test("refetches the token when the cached one is near expiry", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 30));
      await getAccessToken();
      expect(fetchCalls.length).toBe(1);

      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      await getAccessToken();
      expect(fetchCalls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test("throws with gateway code/message when auth fails", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(jsonResponse(400, { code: "INVALID_CLIENT", message: "bad credentials" }));
      expect(getAccessToken()).rejects.toThrow(/INVALID_CLIENT/);
    } finally {
      restore();
    }
  });
});

// ------------------------------------------------------- initiate payment --

describe("phonepe initiate payment", () => {
  test("creates a PG_CHECKOUT session and returns the checkout URL", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      fetchDequeues.push(
        jsonResponse(200, {
          orderId: "OMO123456789",
          state: "PENDING",
          expireAt: 1703756259307,
          redirectUrl: "https://mercury-uat.phonepe.com/transact/uat_v2?token=abc",
        })
      );

      const result = await initiatePayment({
        paymentId: randomUUID(),
        amountPaise: 4900,
        merchantUserId: "user-1",
        redirectUrl: "https://api.example/payments/phonepe/return",
        phoneNumber: "+919876543210",
      });

      expect(result.redirectUrl).toContain("mercury-uat.phonepe.com");
      expect(result.orderId).toBe("OMO123456789");

      const payCall = fetchCalls[1]!;
      expect(payCall.url).toContain("/checkout/v2/pay");
      expect(payCall.init?.method).toBe("POST");
      expect(payCall.init?.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: "O-Bearer test-access-token",
      });
      const sent = JSON.parse(String(payCall.init?.body));
      expect(sent.paymentFlow).toEqual({ type: "PG_CHECKOUT", merchantUrls: { redirectUrl: "https://api.example/payments/phonepe/return" } });
      expect(sent.amount).toBe(4900);
      expect(sent.disablePaymentRetry).toBe(true);
      expect(sent.prefillUserLoginDetails).toEqual({ phoneNumber: "+919876543210" });
      expect(sent.merchantOrderId).toMatch(/^SUP/);
    } finally {
      restore();
    }
  });

  test("throws with gateway code/message when initiate is rejected (400)", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      fetchDequeues.push(jsonResponse(400, { code: "BAD_REQUEST", message: "Please check the inputs you have provided." }));

      expect(
        initiatePayment({
          paymentId: randomUUID(),
          amountPaise: 4900,
          merchantUserId: "user-1",
          redirectUrl: "https://api.example/payments/phonepe/return",
        })
      ).rejects.toThrow(/BAD_REQUEST/);
    } finally {
      restore();
    }
  });
});

// ----------------------------------------------------------- payment status --

describe("phonepe order status", () => {
  test("maps COMPLETED order and reads the transaction id from attempts", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      fetchDequeues.push(
        jsonResponse(200, {
          orderId: "OMO2403282020198641071317",
          state: "COMPLETED",
          amount: 4900,
          expireAt: 1711867462542,
          paymentDetails: [{ paymentMode: "UPI_QR", transactionId: "OM12334", timestamp: 1711694662542, amount: 4900, state: "COMPLETED" }],
        })
      );

      const status = await checkPaymentStatus("SUP123");
      expect(status.paymentState).toBe("COMPLETED");
      expect(status.transactionId).toBe("OM12334");
      expect(status.responseCode).toBeNull();

      const statusCall = fetchCalls[1]!;
      expect(statusCall.url).toContain("/checkout/v2/order/SUP123/status");
      expect(statusCall.init?.method ?? "GET").toBe("GET");
    } finally {
      restore();
    }
  });

  test("maps FAILED order and surfaces the error code", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      fetchDequeues.push(
        jsonResponse(200, {
          orderId: "OMO2407121214395503786511",
          state: "FAILED",
          amount: 4900,
          expireAt: 1720767279548,
          errorCode: "INVALID_MPIN",
          paymentDetails: [{ paymentMode: "UPI", transactionId: "OM5678", state: "FAILED", errorCode: "INVALID_MPIN" }],
        })
      );

      const status = await checkPaymentStatus("SUP456");
      expect(status.paymentState).toBe("FAILED");
      expect(status.responseCode).toBe("INVALID_MPIN");
    } finally {
      restore();
    }
  });

  test("throws when the merchant order id is unknown", async () => {
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      fetchDequeues.push(jsonResponse(400, { code: "INVALID_MERCHANT_ORDER_ID", message: "No entry found for given merchant order id" }));

      expect(checkPaymentStatus("SUPnope")).rejects.toThrow(/INVALID_MERCHANT_ORDER_ID/);
    } finally {
      restore();
    }
  });
});

// ------------------------------------------------------------- webhook sig --

describe("phonepe webhook signature", () => {
  afterEach(() => {
    delete process.env.PHONEPE_WEBHOOK_SECRET;
    delete process.env.PHONEPE_WEBHOOK_USERNAME;
    delete process.env.PHONEPE_WEBHOOK_PASSWORD;
    process.env.PHONEPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  test("accepts when no webhook auth is configured", () => {
    delete process.env.PHONEPE_WEBHOOK_SECRET;
    delete process.env.PHONEPE_WEBHOOK_USERNAME;
    delete process.env.PHONEPE_WEBHOOK_PASSWORD;
    expect(verifyWebhookSignature('{"event":"checkout.order.completed"}', {})).toBe(true);
  });

  test("verifies the HMAC checksum signature", () => {
    const raw = JSON.stringify({ hello: 1 });
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex");
    expect(verifyWebhookSignature(raw, { "phonepe-checksum-signature": signature })).toBe(true);
    expect(verifyWebhookSignature(raw, { "phonepe-checksum-signature": signature + "x" })).toBe(false);
    expect(verifyWebhookSignature(raw, {})).toBe(false);
  });

  test("verifies the SHA username:password authorization header", () => {
    delete process.env.PHONEPE_WEBHOOK_SECRET;
    process.env.PHONEPE_WEBHOOK_USERNAME = "webhook-user";
    process.env.PHONEPE_WEBHOOK_PASSWORD = "webhook-pass";
    const expected = createHash("sha256").update("webhook-user:webhook-pass", "utf8").digest("hex");
    expect(verifyWebhookSignature('{}', { authorization: expected })).toBe(true);
    expect(verifyWebhookSignature('{}', { authorization: "nope" })).toBe(false);
  });
});

// ------------------------------------------------------------- webhook api --

describe("phonepe webhook", () => {
  test("rejects a request with a bad HMAC signature", async () => {
    const { body } = signedWebhook("SUPwhatever", "COMPLETED");
    const res = await postWebhook(body, "bad-signature");
    expect(res.status).toBe(401);
  });

  test("settles a question payment on checkout.order.completed", async () => {
    const { payment, question, merchantOrderId } = await makePhonePeQuestionPayment(
      "Will this webhook settle me?"
    );
    const { body, signature } = signedWebhook(merchantOrderId, "COMPLETED");
    const res = await postWebhook(body, signature);
    expect(res.status).toBe(200);
    const ack = await json<{ success: boolean; code: string }>(res);
    expect(ack).toEqual({ success: true, code: "PAYMENT_SUCCESS" });

    const { db } = await import("../prisma/db");
    const updated = await db.payment.findUnique({ where: { id: payment.id } });
    expect(updated?.status).toBe("Succeeded");
    expect(updated?.providerPaymentId).toBe("T1234");
    expect(
      (updated?.rawWebhookPayload as { payload?: { state?: string } }).payload?.state
    ).toBe("COMPLETED");
    const settledQuestion = await db.question.findUnique({ where: { id: question.id } });
    expect(settledQuestion?.status).toBe("Queued");
  });

  test("marks a payment Failed when the gateway reports FAILED", async () => {
    const { payment, merchantOrderId } = await makePhonePeQuestionPayment("Failed txn?");
    const { body, signature } = signedWebhook(merchantOrderId, "FAILED");
    const res = await postWebhook(body, signature);
    expect(res.status).toBe(200);

    const { db } = await import("../prisma/db");
    const updated = await db.payment.findUnique({ where: { id: payment.id } });
    expect(updated?.status).toBe("Failed");
  });

  test("settlement is idempotent on duplicate callbacks", async () => {
    const { payment, question, merchantOrderId } = await makePhonePeQuestionPayment(
      "Duplicate callback?"
    );
    const { body, signature } = signedWebhook(merchantOrderId, "COMPLETED");
    await postWebhook(body, signature);
    const again = await postWebhook(body, signature);
    expect(again.status).toBe(200);

    const { db } = await import("../prisma/db");
    const updated = await db.payment.findUnique({ where: { id: payment.id } });
    expect(updated?.status).toBe("Succeeded");
    const settledQuestion = await db.question.findUnique({ where: { id: question.id } });
    expect(settledQuestion?.status).toBe("Queued");
  });

  test("acknowledges (2xx) callbacks for unknown merchant order ids", async () => {
    const { body, signature } = signedWebhook("SUPunknownpage", "COMPLETED");
    const res = await postWebhook(body, signature);
    expect(res.status).toBe(200);
    const ack = await json<{ success: boolean; code: string }>(res);
    expect(ack.code).toBe("UNKNOWN_MERCHANT_TRANSACTION_ID");
  });

  test("rejects a payload without payload.merchantOrderId", async () => {
    const body = { event: "checkout.order.completed", payload: { state: "COMPLETED" } };
    const signature = createHmac("sha256", WEBHOOK_SECRET)
      .update(JSON.stringify(body), "utf8")
      .digest("hex");
    const res = await postWebhook(body, signature);
    expect(res.status).toBe(400);
  });
});

// ------------------------------------------------------- initiate + read --

describe("phonepe initiate + read", () => {
  test("initiate returns mode mock when PhonePe is not configured", async () => {
    const { db } = await import("../prisma/db");
    const payment = await db.payment.create({
      data: {
        payerId: clientId,
        payeeAstrologerId: astrologer.profile.id,
        amountPaise: 4900,
        currency: "INR",
        provider: "mock",
        purpose: "Question",
      },
    });
    const savedId = process.env.PHONEPE_CLIENT_ID;
    const savedVersion = process.env.PHONEPE_CLIENT_VERSION;
    const savedSecret = process.env.PHONEPE_CLIENT_SECRET;
    delete process.env.PHONEPE_CLIENT_ID;
    delete process.env.PHONEPE_CLIENT_VERSION;
    delete process.env.PHONEPE_CLIENT_SECRET;
    try {
      const res = await fetch(`${base}/payments/${payment.id}/initiate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo: "http://localhost:3002/my/questions" }),
      });
      expect(res.status).toBe(200);
      const body = await json<{ mode: string; redirectUrl: string | null; payment: { status: string } }>(res);
      expect(body.mode).toBe("mock");
      expect(body.redirectUrl).toBeNull();
      expect(body.payment.status).toBe("Created");
    } finally {
      if (savedId) process.env.PHONEPE_CLIENT_ID = savedId;
      if (savedVersion) process.env.PHONEPE_CLIENT_VERSION = savedVersion;
      if (savedSecret) process.env.PHONEPE_CLIENT_SECRET = savedSecret;
    }
  });

  test("GET /payments/:id is payer-only and read-only", async () => {
    const { db } = await import("../prisma/db");
    const payment = await db.payment.create({
      data: {
        payerId: clientId,
        payeeAstrologerId: astrologer.profile.id,
        amountPaise: 100,
        currency: "INR",
        provider: "mock",
        purpose: "Question",
      },
    });

    const ok = await fetch(`${base}/payments/${payment.id}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    expect(ok.status).toBe(200);
    const body = await json<{ payment: { id: string; status: string; purpose: string } }>(ok);
    expect(body.payment.id).toBe(payment.id);
    expect(body.payment.status).toBe("Created");
    expect(body.payment.purpose).toBe("Question");
  });
});

// --------------------------------------------------------- return redirect --

describe("phonepe return redirect", () => {
  test("settles a COMPLETED order and redirects home with status=success", async () => {
    const { db } = await import("../prisma/db");
    const { payment, question, merchantOrderId } = await makePhonePeQuestionPayment(
      "Return me after paying?"
    );
    await db.payment.update({
      where: { id: payment.id },
      data: { clientDetails: { returnTo: "http://localhost:3002/my/questions" } },
    });

    // Keep the real transport for the request to our own server while the
    // in-process server's PhonePe calls use the mock.
    const transport = globalThis.fetch;
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      fetchDequeues.push(
        jsonResponse(200, {
          orderId: "OMO999",
          state: "COMPLETED",
          amount: 4900,
          paymentDetails: [{ transactionId: "RT777" }],
        })
      );

      const res = await transport(
        `${base}/payments/phonepe/return?paymentId=${payment.id}&merchantOrderId=${merchantOrderId}`,
        { redirect: "manual" }
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("http://localhost:3002/my/questions");
      expect(location).toContain(`paymentId=${payment.id}`);
      expect(location).toContain("status=success");

      const settled = await db.payment.findUnique({ where: { id: payment.id } });
      expect(settled?.status).toBe("Succeeded");
      expect(settled?.providerPaymentId).toBe("RT777");
      const settledQuestion = await db.question.findUnique({ where: { id: question.id } });
      expect(settledQuestion?.status).toBe("Queued");
    } finally {
      restore();
    }
  });

  test("marks a FAILED order and redirects with status=failed", async () => {
    const { db } = await import("../prisma/db");
    const { payment, merchantOrderId } = await makePhonePeQuestionPayment("Fail me back?");
    const transport = globalThis.fetch;
    const restore = installFetchMock();
    try {
      fetchDequeues.push(authTokenResponse(Math.floor(Date.now() / 1000) + 3600));
      fetchDequeues.push(jsonResponse(200, { orderId: "OMO", state: "FAILED", paymentDetails: [] }));

      const res = await transport(
        `${base}/payments/phonepe/return?merchantOrderId=${merchantOrderId}`,
        { redirect: "manual" }
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("status=failed");
      expect(location).toContain(`paymentId=${payment.id}`);

      const updated = await db.payment.findUnique({ where: { id: payment.id } });
      expect(updated?.status).toBe("Failed");
    } finally {
      restore();
    }
  });

  test("still redirects (status=pending) when gateway status is unavailable", async () => {
    const { db } = await import("../prisma/db");
    const { payment, merchantOrderId } = await makePhonePeQuestionPayment("No status?");
    const transport = globalThis.fetch;
    const restore = installFetchMock();
    try {
      // Empty queue -> every PhonePe call throws; the handler must not strand the user.
      const res = await transport(
        `${base}/payments/phonepe/return?merchantOrderId=${merchantOrderId}`,
        { redirect: "manual" }
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("status=pending");

      const updated = await db.payment.findUnique({ where: { id: payment.id } });
      expect(updated?.status).toBe("Created");
    } finally {
      restore();
    }
  });

  test("redirects with status=error when no payment can be resolved", async () => {
    const res = await fetch(`${base}/payments/phonepe/return?paymentId=${randomUUID()}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("status=error");
  });
});