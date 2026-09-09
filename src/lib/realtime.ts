import { db } from "../../prisma/db";
import { verifyAccessToken } from "./auth";
import { UserRole } from "@prisma/client";

/**
 * Real-time push channel for question chats.
 *
 * Runs as a small Bun-native WebSocket server (honoring the "prefer Bun's
 * built-in WebSocket over `ws`" rule) on its own port since the REST API is
 * Express, which has no `app.fetch`. Clients authenticate with the same JWT
 * they send over HTTP (as a query param, since browsers can't set WS headers)
 * and subscribe to a per-question topic. REST writes then `publish` events to
 * that topic so every participant's chat updates instantly.
 */

interface RealtimeData {
  token: string;
  userId: string | null;
  role: string | null;
  questionId: string | null;
}

export interface QuestionMessageEvent {
  type: "question.message";
  questionId: string;
  message: {
    id: string;
    senderId: string;
    senderRole: "Client" | "Astrologer";
    body: string;
    createdAt: string;
    sender?: { id: string; name: string } | null;
  };
  question: { id: string; status: string };
}

export interface QuestionUpdatedEvent {
  type: "question.updated";
  questionId: string;
  question: { id: string; status: string };
}

let server: Bun.Server<RealtimeData> | null = null;

function topicForQuestion(questionId: string) {
  return `question:${questionId}`;
}

function topicForUser(userId: string) {
  return `user:${userId}`;
}

function publish(topic: string, payload: object) {
  server?.publish(topic, JSON.stringify(payload));
}

export function startRealtimeServer(port: number): Bun.Server<RealtimeData> {
  server = Bun.serve<RealtimeData>({
    port,
    idleTimeout: Number(process.env.WS_IDLE_TIMEOUT ?? 60),
    fetch: (req, socketServer) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const token = url.searchParams.get("token") ?? "";
        const questionId = url.searchParams.get("questionId") ?? "";
        if (!token) {
          return new Response("Missing token", { status: 401 });
        }
        const upgraded = socketServer.upgrade(req, {
          data: {
            token,
            userId: null,
            role: null,
            questionId: questionId.length > 0 ? questionId : null,
          },
        });
        return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
      }
      return new Response("Supertalks realtime", { status: 404 });
    },
    websocket: {
      open: async (ws: Bun.ServerWebSocket<RealtimeData>) => {
        const data = ws.data;
        try {
          const payload = await verifyAccessToken(data.token);
          if (!payload.sub) {
            ws.close(4401, "unauthorized");
            return;
          }
          const user = await db.user.findUnique({
            where: { id: payload.sub as string },
            select: { id: true, role: true },
          });
          if (!user) {
            ws.close(4401, "unauthorized");
            return;
          }

          data.userId = user.id;
          data.role = user.role;

          if (data.questionId) {
            const question = await db.question.findUnique({
              where: { id: data.questionId },
              select: { clientId: true, astrologer: { select: { userId: true } } },
            });
            if (!question) {
              ws.close(4404, "question not found");
              return;
            }
            const isAstrologer =
              user.role === UserRole.Astrologer && question.astrologer.userId === user.id;
            if (question.clientId !== user.id && !isAstrologer) {
              ws.close(4403, "not a participant");
              return;
            }
            ws.subscribe(topicForQuestion(data.questionId));
          }

          ws.subscribe(topicForUser(user.id));
          ws.send(
            JSON.stringify({
              type: "connected",
              userId: user.id,
              role: user.role,
              questionId: data.questionId,
            }),
          );
        } catch {
          ws.close(4401, "unauthorized");
        }
      },
      message: (ws: Bun.ServerWebSocket<RealtimeData>, raw: string | ArrayBuffer | Uint8Array) => {
        try {
          const parsed = JSON.parse(String(raw)) as { type?: string };
          if (parsed?.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch {
          // Ignore malformed payloads.
        }
      },
      close: () => {
        // Bun unsubscribes a socket from all topics automatically on close.
      },
    },
  });
  return server;
}

/** Broadcast a newly created chat message to everyone subscribed to the question. */
export async function broadcastMessage(questionId: string, messageId: string) {
  const message = await db.questionMessage.findUnique({
    where: { id: messageId },
    include: { sender: { select: { id: true, name: true } } },
  });
  if (!message) return;

  const question = await db.question.findUnique({
    where: { id: questionId },
    select: { id: true, status: true },
  });
  if (!question) return;

  const event: QuestionMessageEvent = {
    type: "question.message",
    questionId,
    message: {
      id: message.id,
      senderId: message.senderId,
      senderRole: message.senderRole as "Client" | "Astrologer",
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      sender: message.sender,
    },
    question: { id: question.id, status: question.status },
  };
  publish(topicForQuestion(questionId), event);
}

/** Broadcast a question status change to the thread and both participants' user topics. */
export async function broadcastQuestionUpdate(questionId: string) {
  const question = await db.question.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      status: true,
      clientId: true,
      astrologer: { select: { userId: true } },
    },
  });
  if (!question) return;

  const event: QuestionUpdatedEvent = {
    type: "question.updated",
    questionId,
    question: { id: question.id, status: question.status },
  };
  publish(topicForQuestion(questionId), event);
  if (question.clientId) publish(topicForUser(question.clientId), event);
  if (question.astrologer?.userId) publish(topicForUser(question.astrologer.userId), event);
}