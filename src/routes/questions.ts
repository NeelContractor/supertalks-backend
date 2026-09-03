import { Router } from "express";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { sendValidationError, paramString } from "../lib/http";
import { QuestionStatus, UserRole } from "@prisma/client";
import {
  createQuestionSchema,
  answerQuestionSchema,
  rejectQuestionSchema,
} from "../types/questions";

const router = Router();

const ANSWERABLE: QuestionStatus[] = [
  QuestionStatus.PendingPayment,
  QuestionStatus.Queued,
];

function inStatus(status: QuestionStatus, list: QuestionStatus[]): boolean {
  return list.includes(status);
}

async function getQuestion(id: string | string[] | undefined) {
  const parsed = paramString(id);
  if (!parsed) return null;
  return db.question.findUnique({ where: { id: parsed } });
}

async function getAstrologerProfileId(userId: string) {
  const profile = await db.astrologerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

/**
 * @openapi
 * /questions:
 *   get:
 *     tags: [Questions]
 *     summary: List my questions (client or astrologer view)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *           enum: [PendingPayment, Queued, Answered, Rejected, Refunded]
 *     responses:
 *       200: { description: List of questions }
 *       400: { description: Invalid status filter }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const userId = req.user!.id;

    const statusFilter =
      typeof status === "string" && status.length > 0 ? status : undefined;
    if (statusFilter && !(statusFilter in QuestionStatus)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) return res.status(401).json({ error: "User not found" });

    let where: Record<string, unknown> = {};
    if (user.role === UserRole.Astrologer) {
      const profileId = await getAstrologerProfileId(userId);
      if (!profileId) {
        return res.status(403).json({ error: "User is not an astrologer" });
      }
      where.astrologerId = profileId;
    } else {
      where.clientId = userId;
    }

    if (statusFilter) where.status = statusFilter;

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Base where scoped to the user (no status filter) for computing tab counts
    const { status: _status, ...countWhere } = where;

    const [questions, total, allTotal, queued, answered, rejected, refunded] = await Promise.all([
      db.question.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          client: { select: { id: true, name: true } },
          astrologer: {
            select: {
              id: true,
              user: { select: { name: true } },
            },
          },
        },
      }),
      db.question.count({ where }),
      db.question.count({ where: countWhere }),
      db.question.count({ where: { ...countWhere, status: "Queued" } }),
      db.question.count({ where: { ...countWhere, status: "Answered" } }),
      db.question.count({ where: { ...countWhere, status: "Rejected" } }),
      db.question.count({ where: { ...countWhere, status: "Refunded" } }),
    ]);

    return res.json({
      questions,
      total,
      counts: {
        all: allTotal,
        Queued: queued,
        Answered: answered,
        Rejected: rejected,
        Refunded: refunded,
      },
    });
  } catch (err) {
    console.error("List questions error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /questions:
 *   post:
 *     tags: [Questions]
 *     summary: Ask a question as a client
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [astrologerId, questionText]
 *             properties:
 *               astrologerId: { type: string, format: uuid }
 *               questionText: { type: string, minLength: 10, maxLength: 1000 }
 *               category: { type: string, maxLength: 40 }
 *     responses:
 *       201: { description: Question created }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       404: { description: Astrologer not found }
 *       500: { description: Internal server error }
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const parsed = createQuestionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const clientId = req.user!.id;
    const { astrologerId, questionText, category } = parsed.data;

    const astrologer = await db.astrologerProfile.findUnique({
      where: { id: astrologerId },
    });
    if (!astrologer) return res.status(404).json({ error: "Astrologer not found" });

    const question = await db.question.create({
      data: {
        clientId,
        astrologerId,
        questionText,
        category,
        pricePaise: astrologer.questionPricePaise,
        status: QuestionStatus.PendingPayment,
      },
    });

    return res.status(201).json({ question });
  } catch (err) {
    console.error("Create question error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /questions/{id}:
 *   get:
 *     tags: [Questions]
 *     summary: Get a question by id (own questions only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Question }
 *       401: { description: Unauthorized }
 *       403: { description: Not allowed to view this question }
 *       404: { description: Question not found }
 *       500: { description: Internal server error }
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const question = await getQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });

    const profileId = await getAstrologerProfileId(userId);
    const isOwner =
      question.clientId === userId || (profileId !== null && question.astrologerId === profileId);

    if (!isOwner) {
      return res.status(403).json({ error: "Not allowed to view this question" });
    }

    return res.json({ question });
  } catch (err) {
    console.error("Get question error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /questions/{id}/answer:
 *   patch:
 *     tags: [Questions]
 *     summary: Answer a question (astrologer only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [answerText]
 *             properties:
 *               answerText: { type: string, minLength: 1, maxLength: 5000 }
 *     responses:
 *       200: { description: Question answered }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Not the assigned astrologer or invalid state }
 *       404: { description: Question not found }
 *       500: { description: Internal server error }
 */
router.patch("/:id/answer", requireAuth, async (req, res) => {
  try {
    const parsed = answerQuestionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const question = await getQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });

    const profileId = await getAstrologerProfileId(userId);
    if (!profileId || question.astrologerId !== profileId) {
      return res.status(403).json({ error: "Only the assigned astrologer can answer" });
    }

    if (!inStatus(question.status, ANSWERABLE)) {
      return res.status(403).json({ error: "Question is not answerable" });
    }

    const updated = await db.question.update({
      where: { id: question.id },
      data: {
        answerText: parsed.data.answerText,
        status: QuestionStatus.Answered,
        answeredAt: new Date(),
      },
    });

    return res.json({ question: updated });
  } catch (err) {
    console.error("Answer question error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /questions/{id}/reject:
 *   patch:
 *     tags: [Questions]
 *     summary: Reject a question (astrologer only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string, maxLength: 300 }
 *     responses:
 *       200: { description: Question rejected }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Not the assigned astrologer or invalid state }
 *       404: { description: Question not found }
 *       500: { description: Internal server error }
 */
router.patch("/:id/reject", requireAuth, async (req, res) => {
  try {
    const parsed = rejectQuestionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const question = await getQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });

    const profileId = await getAstrologerProfileId(userId);
    if (!profileId || question.astrologerId !== profileId) {
      return res.status(403).json({ error: "Only the assigned astrologer can reject" });
    }

    if (!inStatus(question.status, ANSWERABLE)) {
      return res.status(403).json({ error: "Question is not rejectable" });
    }

    const updated = await db.question.update({
      where: { id: question.id },
      data: {
        status: QuestionStatus.Rejected,
        rejectionReason: parsed.data.reason,
      },
    });

    return res.json({ question: updated });
  } catch (err) {
    console.error("Reject question error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
