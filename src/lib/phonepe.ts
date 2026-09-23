import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * PhonePe Payment Gateway (Standard Checkout v2) client.
 *
 * Docs: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-integration-website
 *
 * This module implements the OAuth-based ("v2") PhonePe API:
 *
 *   - POST {auth}/v1/oauth/token            -> O-Bearer access token (cached)
 *   - POST {gateway}/checkout/v2/pay        -> create a checkout session
 *   - GET  {gateway}/checkout/v2/order/{merchantOrderId}/status
 *
 * Config (read lazily so tests can set env / swap providers at will):
 *   PHONEPE_ENV                      sandbox (default) | production
 *   PHONEPE_CLIENT_ID                client id issued by PhonePe
 *   PHONEPE_CLIENT_VERSION           client version issued by PhonePe
 *   PHONEPE_CLIENT_SECRET            client secret issued by PhonePe
 *   PHONEPE_BASE_URL                 public base URL of THIS backend, used to
 *                                    build the redirect URL PhonePe bounces the
 *                                    user back to (https in production)
 *   PHONEPE_WEBHOOK_SECRET           optional HMAC secret key for webhooks
 *   PHONEPE_WEBHOOK_USERNAME/_PASSWORD  optional webhook basic-auth (SHA) creds
 *   PHONEPE_API_BASE_URL             optional override of the gateway API base
 *   PHONEPE_AUTH_API_BASE_URL        optional override of the oauth token base
 */

export type PhonePeEnv = "sandbox" | "production";

const GATEWAY_BASES: Record<PhonePeEnv, string> = {
  sandbox: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  production: "https://api.phonepe.com/apis/pg",
};

const AUTH_BASES: Record<PhonePeEnv, string> = {
  sandbox: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  production: "https://api.phonepe.com/apis/identity-manager",
};

export interface PhonePeConfig {
  enabled: boolean;
  clientId: string;
  clientVersion: string;
  env: PhonePeEnv;
  gatewayBase: string;
  authBase: string;
  webhookSecret: string | undefined;
}

export function phonePeEnv(): PhonePeEnv {
  const raw = (process.env.PHONEPE_ENV ?? "sandbox").toLowerCase();
  return raw === "production" || raw === "prod" || raw === "live" ? "production" : "sandbox";
}

export function getPhonePeConfig(): PhonePeConfig {
  const clientId = (process.env.PHONEPE_CLIENT_ID ?? "").trim();
  const clientVersion = (process.env.PHONEPE_CLIENT_VERSION ?? "").trim();
  const clientSecret = (process.env.PHONEPE_CLIENT_SECRET ?? "").trim();
  const env = phonePeEnv();
  const gatewayBase = (
    process.env.PHONEPE_API_BASE_URL ?? GATEWAY_BASES[env]
  ).replace(/\/+$/, "");
  const authBase = (
    process.env.PHONEPE_AUTH_API_BASE_URL ?? AUTH_BASES[env]
  ).replace(/\/+$/, "");
  const webhookSecret = (process.env.PHONEPE_WEBHOOK_SECRET ?? "").trim() || undefined;
  return {
    enabled: Boolean(clientId && clientVersion && clientSecret),
    clientId,
    clientVersion,
    env,
    gatewayBase,
    authBase,
    webhookSecret,
  };
}

/** Public base URL of this backend for building PhonePe-facing redirect URLs. */
export function phonePeBaseUrl(): string {
  return (process.env.PHONEPE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Which provider label is written onto newly created Payment intents. */
export function activePaymentProvider(): "phonepe" | "mock" {
  return getPhonePeConfig().enabled ? "phonepe" : "mock";
}

/**
 * PhonePe merchantOrderId must be <= 63 chars and only allow [a-zA-Z0-9_-].
 * Derive a deterministic one from a payment id so re-initiating is idempotent.
 */
export function merchantTransactionIdFor(paymentId: string): string {
  return `SUP${paymentId.replace(/-/g, "")}`;
}

// ------------------------------------------------------------------ auth --

interface CachedToken {
  token: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

/** Clear the cached O-Bearer token (used by tests). */
export function resetPhonePeAuthCache(): void {
  tokenCache = null;
}

async function fetchAccessToken(): Promise<CachedToken> {
  const cfg = getPhonePeConfig();
  if (!cfg.enabled) throw new Error("PhonePe is not configured");

  const res = await fetch(`${cfg.authBase}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_version: cfg.clientVersion,
      client_secret: process.env.PHONEPE_CLIENT_SECRET ?? "",
      grant_type: "client_credentials",
    }),
  });

  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || json === null || typeof json !== "object") {
    const code = json?.code ?? res.status;
    const message = json?.message ?? text.slice(0, 200);
    throw new Error(`PhonePe auth failed (${res.status}): ${code} ${message}`);
  }

  const token = typeof json.access_token === "string" ? json.access_token : "";
  const expiresAt = typeof json.expires_at === "number" ? json.expires_at : 0;
  if (!token) {
    throw new Error(`PhonePe auth returned no access token`);
  }

  return { token, expiresAt };
}

/** O-Bearer token for the standard-checkout APIs, cached until near expiry. */
export async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 60) {
    return tokenCache.token;
  }
  tokenCache = await fetchAccessToken();
  return tokenCache.token;
}

// ---------------------------------------------------------------- webhook --

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface WebhookHeaders {
  authorization?: string | string[] | undefined;
  ["phonepe-checksum-signature"]?: string | string[] | undefined;
  ["x-phonepe-checksum-key-id"]?: string | string[] | undefined;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify an incoming PhonePe webhook.
 *
 * Two auth methods are supported by the dashboard:
 *   - SHA (basic): Authorization header == sha256hex(`${username}:${password}`)
 *   - HMAC: phonepe-checksum-signature header == HMAC-SHA256(rawBody, secret)
 *
 * If neither is configured we accept the payload (verification is only
 * possible once a webhook is created in the PhonePe dashboard).
 */
export function verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): boolean {
  const username = (process.env.PHONEPE_WEBHOOK_USERNAME ?? "").trim();
  const password = (process.env.PHONEPE_WEBHOOK_PASSWORD ?? "").trim();
  if (username || password) {
    const permission = firstHeader(headers.authorization);
    const expected = sha256Hex(`${username}:${password}`);
    return permission !== undefined && safeEqual(permission, expected);
  }

  const secret = getPhonePeConfig().webhookSecret;
  if (secret) {
    const provided = firstHeader(headers["phonepe-checksum-signature"]);
    if (!provided) return false;
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    return safeEqual(provided, expected);
  }

  return true;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ------------------------------------------------------------------- API --

export interface InitiatePaymentInput {
  paymentId: string;
  amountPaise: number;
  merchantUserId: string;
  redirectUrl: string;
  phoneNumber?: string;
}

export interface InitiatePaymentResult {
  merchantOrderId: string;
  orderId: string;
  redirectUrl: string;
}

/**
 * Create a PhonePe Standard Checkout session. The returned redirectUrl is what
 * the browser should navigate to so the user can complete payment.
 */
export async function initiatePayment(
  input: InitiatePaymentInput
): Promise<InitiatePaymentResult> {
  const cfg = getPhonePeConfig();
  if (!cfg.enabled) throw new Error("PhonePe is not configured");

  const merchantOrderId = merchantTransactionIdFor(input.paymentId);
  const token = await getAccessToken();

  const res = await fetch(`${cfg.gatewayBase}/checkout/v2/pay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `O-Bearer ${token}`,
    },
    body: JSON.stringify({
      merchantOrderId,
      amount: input.amountPaise,
      expireAfter: 3600,
      paymentFlow: {
        type: "PG_CHECKOUT",
        merchantUrls: { redirectUrl: input.redirectUrl },
      },
      disablePaymentRetry: true,
      ...(input.phoneNumber ? { prefillUserLoginDetails: { phoneNumber: input.phoneNumber } } : {}),
      metaInfo: {
        udf1: `payment:${input.paymentId}`,
        udf2: `user:${input.merchantUserId}`,
      },
    }),
  });

  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || json === null || typeof json !== "object") {
    const code = json?.code ?? res.status;
    const message = json?.message ?? text.slice(0, 200);
    throw new Error(`PhonePe initiate failed (${res.status}): ${code} ${message}`);
  }

  const orderId = typeof json.orderId === "string" ? json.orderId : "";
  const redirectUrl = typeof json.redirectUrl === "string" ? json.redirectUrl : "";
  if (!orderId || !redirectUrl) {
    throw new Error(`PhonePe returned no checkout URL: ${json.code ?? json.message ?? "unknown error"}`);
  }

  return { merchantOrderId, orderId, redirectUrl };
}

export type PaymentGatewayState = "PENDING" | "FAILED" | "COMPLETED";

export interface PaymentStatus {
  paymentState: "COMPLETED" | "FAILED" | "PENDING" | "UNKNOWN";
  orderId: string | null;
  transactionId: string | null;
  responseCode: string | null;
  raw: unknown;
}

/**
 * Query the gateway for the final state of an order (used after the user
 * returns from the checkout, and as a fallback when the webhook is missed).
 */
export async function checkPaymentStatus(merchantOrderId: string): Promise<PaymentStatus> {
  const cfg = getPhonePeConfig();
  if (!cfg.enabled) throw new Error("PhonePe is not configured");

  const token = await getAccessToken();
  const url = `${cfg.gatewayBase}/checkout/v2/order/${encodeURIComponent(
    merchantOrderId
  )}/status?details=false&errorContext=true`;

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", Authorization: `O-Bearer ${token}` },
  });

  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || json === null || typeof json !== "object") {
    const code = json?.code ?? res.status;
    const message = json?.message ?? text.slice(0, 200);
    throw new Error(`PhonePe status failed (${res.status}): ${code} ${message}`);
  }

  const state = String(json.state ?? "").toUpperCase();
  const paymentState: PaymentStatus["paymentState"] =
    state === "COMPLETED" || state === "FAILED" || state === "PENDING" ? state : "UNKNOWN";

  const details = Array.isArray(json.paymentDetails) ? (json.paymentDetails as unknown[]) : [];
  const lastAttempt = details[details.length - 1] as
    | { transactionId?: unknown }
    | undefined;
  const transactionId = lastAttempt && typeof lastAttempt.transactionId === "string"
    ? lastAttempt.transactionId
    : null;

  return {
    paymentState,
    orderId: typeof json.orderId === "string" ? json.orderId : null,
    transactionId,
    responseCode: typeof json.errorCode === "string" ? json.errorCode : null,
    raw: json,
  };
}

// --------------------------------------------------------- webhook decode --

export interface PhonePeWebhook {
  event?: unknown;
  payload?: {
    merchantOrderId?: unknown;
    orderId?: unknown;
    state?: unknown;
    transactionId?: unknown;
    paymentDetails?: unknown;
  };
}

/** State reported by the root-level payload.state of a webhook. */
export function webhookStateOf(envelope: PhonePeWebhook): string {
  const state = envelope.payload?.state;
  return typeof state === "string" ? state.toUpperCase() : "";
}

/** The gateway transaction id from the latest payment attempt, if any. */
export function webhookTransactionIdOf(envelope: PhonePeWebhook): string | null {
  if (typeof envelope.payload?.transactionId === "string") {
    return envelope.payload.transactionId;
  }
  const details = envelope.payload?.paymentDetails;
  if (Array.isArray(details)) {
    const last = details[details.length - 1] as { transactionId?: unknown };
    if (last && typeof last.transactionId === "string") return last.transactionId;
  }
  return null;
}