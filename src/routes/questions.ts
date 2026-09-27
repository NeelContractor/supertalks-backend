import { Router } from "express";
import { requireAuth, requireCustomer } from "../lib/middleware";
import { db } from "../../prisma/db";
import { sendValidationError, paramString } from "../lib/http";
import { broadcastMessage, broadcastQuestionUpdate } from "../lib/realtime";
import { resolveService } from "../lib/site";
import { PaymentFor, PaymentStatus, Prisma, QuestionStatus, UserRole } from "@prisma/client";
import {
  createQuestionSchema,
  answerQuestionSchema,
  // rejectQuestionSchema, // DISABLED with the reject/unreject routes
  sendQuestionMessageSchema,
  orderQuestionsSchema,
} from "../types/questions";

const router = Router();

/** Statuses in which the assigned astrologer may answer, reject, or message. Paid questions only. */
const ANSWERABLE: QuestionStatus[] = [QuestionStatus.Queued];

/** Statuses in which a client may send messages (each creates a payment intent). */
const CLIENT_CHATTABLE: QuestionStatus[] = [
  QuestionStatus.PendingPayment,
  QuestionStatus.Queued,
  QuestionStatus.Answered,
];

/** Statuses in which the astrologer may send messages (client must have paid at least once). */
const ASTROLOGER_CHATTABLE: QuestionStatus[] = [QuestionStatus.Queued, QuestionStatus.Answered];

function inStatus(status: QuestionStatus, list: QuestionStatus[]): boolean {
  return list.includes(status);
}

async function getQuestion(id: string | string[] | undefined) {
  const parsed = paramString(id);
  if (!parsed) return null;
  return db.question.findUnique({
    where: { id: parsed },
    include: {
      client: { select: { id: true, name: true } },
      astrologer: {
        select: {
          id: true,
          user: { select: { name: true } },
        },
      },
    },
  });
}

async function getAstrologerProfileId(userId: string) {
  const profile = await db.astrologerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

/** Is the given user a participant in this question (client or assigned astrologer)? */
async function isQuestionOwner(
  question: { clientId: string; astrologerId: string },
  userId: string,
): Promise<boolean> {
  if (question.clientId === userId) return true;
  const profileId = await getAstrologerProfileId(userId);
  return profileId !== null && question.astrologerId === profileId;
}

async function listMessages(questionId: string) {
  return db.questionMessage.findMany({
    where: { questionId },
    orderBy: { createdAt: "asc" },
    include: { sender: { select: { id: true, name: true } } },
  });
}

async function createMessage(
  questionId: string,
  senderId: string,
  senderRole: UserRole,
  body: string,
  paymentId?: string,
) {
  return db.questionMessage.create({
    data: { questionId, senderId, senderRole, body, paymentId },
  });
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
 *       - in: query
 *         name: role
 *         required: false
 *         schema:
 *           type: string
 *           enum: [client, astrologer]
 *       - in: query
 *         name: sort
 *         required: false
 *         description: Order by creation time. Defaults to latest.
 *         schema:
 *           type: string
 *           enum: [latest, oldest]
 *     responses:
 *       200: { description: List of questions }
 *       400: { description: Invalid status filter }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, role, sort } = req.query;
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

    // `role` lets a user (e.g. an astrologer who also uses the product as a
    // customer) view questions from the other side. Defaults to their role.
    const viewAs =
      role === "astrologer"
        ? UserRole.Astrologer
        : role === "client"
          ? UserRole.Client
          : user.role;

    let where: Record<string, unknown> = {};
    if (viewAs === UserRole.Astrologer) {
      const profileId = await getAstrologerProfileId(userId);
      if (!profileId) {
        return res.status(403).json({ error: "User is not an astrologer" });
      }
      where.astrologerId = profileId;
      if (statusFilter) {
        where.status = statusFilter;
      } else {
        // Unpaid questions (no paid message yet) are not visible to astrologers.
        where.status = { not: QuestionStatus.PendingPayment };
      }
    } else {
      where.clientId = userId;
      if (statusFilter) where.status = statusFilter;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Unknown/missing values fall back to `latest` so old clients keep working.
    const sortOrder = sort === "oldest" ? "asc" : "desc";

    // Base where scoped to the user (no status filter) for computing tab counts
    const { status: _status, ...countWhere } = where;

    const [questions, total, allTotal, queued, answered, rejected, refunded] = await Promise.all([
      db.question.findMany({
        where,
        // `id` is a stable tiebreaker so offset pagination can't repeat or
        // skip rows when several questions share a createdAt.
        orderBy: [{ createdAt: sortOrder }, { id: sortOrder }],
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
          payment: { select: { clientDetails: true } },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              senderId: true,
              senderRole: true,
              body: true,
              createdAt: true,
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
      questions: questions.map(({ messages, payment, ...question }) => ({
        ...question,
        lastMessage: messages[0] ?? null,
        clientDetails: payment?.clientDetails ?? null,
      })),
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
 *     summary: Ask a question as a customer (any authenticated user)
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
 *       403: { description: Customer access required or astrologer not accepting questions }
 *       404: { description: Astrologer not found }
 *       500: { description: Internal server error }
 */
router.post("/", requireCustomer, async (req, res) => {
  try {
    const parsed = createQuestionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const clientId = req.user!.id;
    const { astrologerId, questionText, category } = parsed.data;

    const astrologer = await db.astrologerProfile.findUnique({
      where: { id: astrologerId },
    });
    if (!astrologer) return res.status(404).json({ error: "Astrologer not found" });

    if (!astrologer.isAcceptingQuestions) {
      return res.status(403).json({ error: "Astrologer is not accepting questions" });
    }

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
 * /questions/batch:
 *   post:
 *     tags: [Questions]
 *     summary: Order multiple questions at once (client selects preset questions and pays in one order)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [astrologerId, items]
 *             properties:
 *               astrologerId: { type: string, format: uuid }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   required: [questionText]
 *                   properties:
 *                     questionText: { type: string, minLength: 3, maxLength: 1000 }
 *                     category: { type: string, maxLength: 40 }
 *     responses:
 *       201:
 *         description: Questions created with a single covering payment intent
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Customer access required or astrologer not accepting questions }
 *       404: { description: Astrologer not found }
 *       500: { description: Internal server error }
 */
router.post("/batch", requireCustomer, async (req, res) => {
  try {
    const parsed = orderQuestionsSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const clientId = req.user!.id;
    const { astrologerId, items, clientDetails } = parsed.data;

    const astrologer = await db.astrologerProfile.findUnique({
      where: { id: astrologerId },
      select: {
        id: true,
        isAcceptingQuestions: true,
        questionPricePaise: true,
        templateId: true,
        templateData: true,
      },
    });
    if (!astrologer) return res.status(404).json({ error: "Astrologer not found" });

    if (!astrologer.isAcceptingQuestions) {
      return res.status(403).json({ error: "Astrologer is not accepting questions" });
    }

    if (astrologer.questionPricePaise <= 0) {
      return res.status(400).json({ error: "Astrologer has not set a question price" });
    }

    // A service card only names the service; each price is read from the
    // astrologer's own site document. A service priced 0 (or an item with no
    // serviceId) falls back to the profile's standard question price.
    const priced: { item: (typeof items)[number]; pricePaise: number }[] = [];
    for (const item of items) {
      if (!item.serviceId) {
        priced.push({ item, pricePaise: astrologer.questionPricePaise });
        continue;
      }
      const service = await resolveService(astrologer, item.serviceId);
      if (!service) {
        return res.status(400).json({ error: "This service is no longer available" });
      }
      if (service.type !== "question") {
        return res.status(400).json({ error: "This service must be booked as a session" });
      }
      priced.push({
        item,
        pricePaise: service.pricePaise > 0 ? service.pricePaise : astrologer.questionPricePaise,
      });
    }

    const totalPaise = priced.reduce((sum, p) => sum + p.pricePaise, 0);

    const result = await db.$transaction(async (tx) => {
      const questions = await Promise.all(
        priced.map(({ item, pricePaise }) =>
          tx.question.create({
            data: {
              clientId,
              astrologerId,
              questionText: item.questionText,
              category: item.category ?? null,
              pricePaise,
              status: QuestionStatus.PendingPayment,
            },
            select: {
              id: true,
              questionText: true,
              category: true,
              pricePaise: true,
              status: true,
              createdAt: true,
            },
          })
        )
      );

      const payment = await tx.payment.create({
        data: {
          payerId: clientId,
          payeeAstrologerId: astrologer.id,
          amountPaise: totalPaise,
          currency: "INR",
          provider: "mock",
          purpose: PaymentFor.Question,
          status: PaymentStatus.Created,
          clientDetails: clientDetails
            ? (clientDetails as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
        select: {
          id: true,
          amountPaise: true,
          currency: true,
          status: true,
          clientDetails: true,
        },
      });

      // One covering payment for the whole order; each question points at it so
      // settling the payment can activate every question at once.
      await tx.question.updateMany({
        where: { id: { in: questions.map((q) => q.id) } },
        data: { paymentId: payment.id },
      });

      return { questions, payment };
    });

    return res.status(201).json({
      payment: {
        id: result.payment.id,
        amountPaise: result.payment.amountPaise,
        currency: result.payment.currency,
        clientDetails: result.payment.clientDetails,
      },
      questions: result.questions,
      count: result.questions.length,
    });
  } catch (err) {
    console.error("Order questions error:", err);
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

    const message = await createMessage(question.id, userId, UserRole.Astrologer, parsed.data.answerText);

    await Promise.all([broadcastMessage(question.id, message.id), broadcastQuestionUpdate(question.id)]);

    return res.json({ question: updated });
  } catch (err) {
    console.error("Answer question error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DISABLED (commented out) for now — reject/unreject is paused.
 * Restore together with `rejectQuestionSchema` in src/types/questions.ts, the
 * questionsApi.reject/unreject client methods, and the Reject/Unreject buttons
 * in frontend/src/pages/Questions.tsx.
 *
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
// router.patch("/:id/reject", requireAuth, async (req, res) {
//   try {
//     const parsed = rejectQuestionSchema.safeParse(req.body ?? {});
//     if (!parsed.success) return sendValidationError(res, parsed.error);

//     const userId = req.user!.id;
//     const question = await getQuestion(req.params.id);
//     if (!question) return res.status(404).json({ error: "Question not found" });

//     const profileId = await getAstrologerProfileId(userId);
//     if (!profileId || question.astrologerId !== profileId) {
//       return res.status(403).json({ error: "Only the assigned astrologer can reject" });
//     }

//     if (!inStatus(question.status, ANSWERABLE)) {
//       return res.status(403).json({ error: "Question is not rejectable" });
//     }

//     const updated = await db.question.update({
//       where: { id: question.id },
//       data: {
//         status: QuestionStatus.Rejected,
//         rejectionReason: parsed.data.reason,
//       },
//     });

//     await broadcastQuestionUpdate(question.id);

//     return res.json({ question: updated });
//   } catch (err) {
//     console.error("Reject question error:", err);
//     return res.status(500).json({ error: "Internal server error" });
//   }
// });

/**
 * DISABLED (commented out) for now — reject/unreject is paused. See the
 * /reject block above for the full restore checklist.
 *
 * @openapi
 * /questions/{id}/unreject:
 *   patch:
 *     tags: [Questions]
 *     summary: Return a rejected question to the queued (answerable) state (astrologer only)
 *     description: Lets an astrologer change their mind after rejecting. The client gets a chance to be answered again.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Question returned to queue }
 *       401: { description: Unauthorized }
 *       403: { description: Not the assigned astrologer or invalid state }
 *       404: { description: Question not found }
 *       500: { description: Internal server error }
 */
// router.patch("/:id/unreject", requireAuth, async (req, res) => {
//   try {
//     const userId = req.user!.id;
//     const question = await getQuestion(req.params.id);
//     if (!question) return res.status(404).json({ error: "Question not found" });

//     const profileId = await getAstrologerProfileId(userId);
//     if (!profileId || question.astrologerId !== profileId) {
//       return res.status(403).json({ error: "Only the assigned astrologer can unreject" });
//     }

//     if (question.status !== QuestionStatus.Rejected) {
//       return res.status(403).json({ error: "Only rejected questions can be unrejected" });
//     }

//     const updated = await db.question.update({
//       where: { id: question.id },
//       data: {
//         status: QuestionStatus.Queued,
//         rejectionReason: null,
//       },
//     });

//     await broadcastQuestionUpdate(question.id);

//     return res.json({ question: updated });
//   } catch (err) {
//     console.error("Unreject question error:", err);
//     return res.status(500).json({ error: "Internal server error" });
//   }
// });

/**
 * @openapi
 * /questions/{id}/messages:
 *   get:
 *     tags: [Questions]
 *     summary: Get the chat thread for a question (participants only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Question and message thread }
 *       401: { description: Unauthorized }
 *       403: { description: Not a participant }
 *       404: { description: Question not found }
 *       500: { description: Internal server error }
 */
router.get("/:id/messages", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const question = await getQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });

    if (!(await isQuestionOwner(question, userId))) {
      return res.status(403).json({ error: "Not allowed to view this question" });
    }

    const messages = await listMessages(question.id);
    return res.json({ question, messages });
  } catch (err) {
    console.error("List question messages error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /questions/{id}/messages:
 *   post:
 *     tags: [Questions]
 *     summary: Send a message in the question chat (participants only)
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
 *             required: [body]
 *             properties:
 *               body: { type: string, minLength: 1, maxLength: 2000 }
 *     responses:
 *       201: { description: Message sent }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Not a participant or thread closed }
 *       404: { description: Question not found }
 *       500: { description: Internal server error }
 */
router.post("/:id/messages", requireAuth, async (req, res) => {
  try {
    const parsed = sendQuestionMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const question = await getQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });

    if (!(await isQuestionOwner(question, userId))) {
      return res.status(403).json({ error: "Not allowed to message this question" });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) return res.status(401).json({ error: "User not found" });

    // Resolve the sender's side by question ownership rather than by user.role,
    // so someone who is both an astrologer and a customer is treated as the
    // client on questions they asked (and pays) and as the astrologer on
    // questions asked of them. The client side wins if both apply.
    const profileId = await getAstrologerProfileId(userId);
    const isAstrologerSide = profileId !== null && question.astrologerId === profileId;
    const isClientSide = question.clientId === userId;
    const senderRole = isClientSide
      ? UserRole.Client
      : isAstrologerSide
        ? UserRole.Astrologer
        : UserRole.Client;

    const chattable =
      senderRole === UserRole.Astrologer
        ? ASTROLOGER_CHATTABLE
        : CLIENT_CHATTABLE;
    if (!inStatus(question.status, chattable)) {
      return res.status(403).json({ error: "This question thread is closed" });
    }

    // Client messages are paid: creating a message creates a payment intent
    // that the client then settles via POST /payments/:paymentId/complete.
    if (senderRole !== UserRole.Astrologer) {
      const payment = await db.payment.create({
        data: {
          payerId: userId,
          payeeAstrologerId: question.astrologerId,
          amountPaise: question.pricePaise,
          currency: "INR",
          provider: "mock",
          purpose: PaymentFor.Question,
          status: PaymentStatus.Created,
          questionId: question.id,
          messageBody: parsed.data.body,
        },
      });
      return res.status(201).json({
        requiresPayment: true,
        payment: {
          id: payment.id,
          amountPaise: payment.amountPaise,
          currency: payment.currency,
        },
        question,
      });
    }

    const message = await createMessage(question.id, userId, senderRole, parsed.data.body);

    let updated: typeof question = question;
    if (inStatus(question.status, ANSWERABLE)) {
      await db.question.update({
        where: { id: question.id },
        data: { status: QuestionStatus.Answered, answeredAt: new Date() },
      });
      updated = (await getQuestion(question.id))!;
    }

    await broadcastMessage(question.id, message.id);
    await broadcastQuestionUpdate(question.id);

    return res.status(201).json({ message, question: updated });
  } catch (err) {
    console.error("Send question message error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
