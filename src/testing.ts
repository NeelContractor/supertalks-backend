// TESTING HELPERS ONLY — astrologer-side backend test harness.
// Provides client-side actions so you can exercise the astrologer APIs.
// DELETE THIS FILE before production.
import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "../prisma/db";
import { requireAuth } from "./lib/middleware";
import { sendValidationError, paramString } from "./lib/http";
import {
  hashPassword,
  signAccessToken,
  generateRefreshToken,
  storeRefreshToken,
} from "./lib/auth";
import {
  UserRole,
  BookingStatus,
  QuestionStatus,
} from "@prisma/client";

const app = express();
app.use(express.json());

const PORT = Number(process.env.TESTING_PORT || 3100);

async function findClient(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true },
  });
  if (!user || user.role !== UserRole.Client) return null;
  return user;
}

async function requireClient(
  req: Request,
  res: Response
): Promise<{ id: string } | null> {
  const user = await findClient(req.user!.id);
  if (!user) {
    res.status(403).json({ error: "Client only" });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------------
// Client account + auth
// ---------------------------------------------------------------------------

/**
 * Register a test client account.
 * POST /testing/clients
 */
const registerClientSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  username: z.string().regex(/^[a-z0-9_]{3,30}$/),
  password: z.string().min(8),
});
app.post("/testing/clients", async (req, res) => {
  try {
    const parsed = registerClientSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const { name, email, username, password } = parsed.data;
    const existing = await db.user.findFirst({
      where: { OR: [{ email }, { username }] },
      select: { email: true },
    });
    if (existing) return res.status(409).json({ error: "User already exists" });

    const passwordHash = await hashPassword(password);
    const user = await db.user.create({
      data: { name, email, username, passwordHash, role: UserRole.Client },
      select: { id: true, name: true, email: true, username: true, role: true },
    });

    const accessToken = await signAccessToken(user.id, user.role);
    const refreshToken = generateRefreshToken();
    await storeRefreshToken(user.id, refreshToken, req.headers["user-agent"], req.ip);

    return res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) {
    console.error("Register test client error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Create a client-role access token for an existing user (test convenience).
 * GET /testing/clients/:userId/token
 */
app.get("/testing/clients/:userId/token", async (req, res) => {
  try {
    const id = paramString(req.params.userId);
    const user = await db.user.findUnique({ where: { id } });
    if (!user || user.role !== UserRole.Client) {
      return res.status(404).json({ error: "Client not found" });
    }
    const token = await signAccessToken(user.id, user.role);
    return res.json({ accessToken: token });
  } catch (err) {
    console.error("Token helper error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Client-side actions (mirror what the client app would do)
// ---------------------------------------------------------------------------

/**
 * Client asks a question. POST /testing/questions
 */
const askQuestionSchema = z.object({
  astrologerId: z.string().uuid(),
  questionText: z.string().trim().min(10).max(1000),
  category: z.string().max(40).optional(),
});
app.post("/testing/questions", requireAuth, async (req, res) => {
  try {
    const client = await requireClient(req, res);
    if (!client) return;

    const parsed = askQuestionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const astrologer = await db.astrologerProfile.findUnique({
      where: { id: parsed.data.astrologerId },
    });
    if (!astrologer) return res.status(404).json({ error: "Astrologer not found" });

    const question = await db.question.create({
      data: {
        clientId: client.id,
        astrologerId: astrologer.id,
        questionText: parsed.data.questionText,
        category: parsed.data.category,
        pricePaise: astrologer.questionPricePaise,
        status: QuestionStatus.PendingPayment,
      },
    });

    return res.status(201).json({ question });
  } catch (err) {
    console.error("Ask question error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Client creates a booking. POST /testing/bookings
 */
const createTestBookingSchema = z.object({
  astrologerId: z.string().uuid(),
  startAt: z.string().datetime(),
});
app.post("/testing/bookings", requireAuth, async (req, res) => {
  try {
    const client = await requireClient(req, res);
    if (!client) return;

    const parsed = createTestBookingSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const astrologer = await db.astrologerProfile.findUnique({
      where: { id: parsed.data.astrologerId },
    });
    if (!astrologer) return res.status(404).json({ error: "Astrologer not found" });

    const start = new Date(parsed.data.startAt);
    const end = new Date(start.getTime() + astrologer.slotDurationMinutes * 60000);

    const booking = await db.booking.create({
      data: {
        clientId: client.id,
        astrologerId: astrologer.id,
        startAt: start,
        endAt: end,
        pricePaise: astrologer.callPricePerSlotPaise,
        status: BookingStatus.PendingPayment,
      },
    });

    return res.status(201).json({ booking });
  } catch (err) {
    console.error("Create test booking error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Testing server running on http://localhost:${PORT}`);
});
