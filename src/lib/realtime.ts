import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { db } from "../../prisma/db";
import { verifyAccessToken } from "./auth";
import { UserRole } from "@prisma/client";

/**
 * Real-time push channel for question chats.
 *
 * Served on the same port as the REST API (shared HTTP server) using the
 * `ws` package. Clients connect to `ws://<host>/ws?token=<jwt>&questionId=<id>`
 * (token as a query param, since browsers can't set WS headers) and subscribe
 * to a per-question topic. REST writes then broadcast events to that topic so
 * every participant's chat updates instantly. Sockets are kept alive with the
 * standard ws heartbeat (ping/pong), and dead connections are terminated.
 */

interface RealtimeData {
  token: string;
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

type Client = WebSocket & { isAlive?: boolean };

let wss: WebSocketServer | null = null;

// topic -> connected sockets
const topics = new Map<string, Set<Client>>();
// socket -> subscribed topics (for cleanup on close)
const clientTopics = new WeakMap<Client, Set<string>>();

const HEARTBEAT_INTERVAL_MS = 30_000;

function cleanTopic(topic: string) {
  const set = topics.get(topic);
  if (set && set.size === 0) topics.delete(topic);
}

function subscribe(ws: Client, topic: string) {
  let set = topics.get(topic);
  if (!set) {
    set = new Set();
    topics.set(topic, set);
  }
  set.add(ws);

  let own = clientTopics.get(ws);
  if (!own) {
    own = new Set();
    clientTopics.set(ws, own);
  }
  own.add(topic);
}

function unsubscribeAll(ws: Client) {
  const own = clientTopics.get(ws);
  if (!own) return;
  for (const topic of own) {
    topics.get(topic)?.delete(ws);
    cleanTopic(topic);
  }
  clientTopics.delete(ws);
}

function publish(topic: string, payload: object) {
  const set = topics.get(topic);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function topicForQuestion(questionId: string) {
  return `question:${questionId}`;
}

function topicForUser(userId: string) {
  return `user:${userId}`;
}

/**
 * Attach the realtime channel to an already-created `http.Server` so the WS
 * endpoint lives on the same port as the REST API.
 */
export function attachRealtime(server: Server): WebSocketServer {
  const socketServer = new WebSocketServer({ server, path: "/ws" });
  wss = socketServer;

  socketServer.on("connection", (rawSocket, req) => {
    const ws = rawSocket as Client;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("close", () => {
      unsubscribeAll(ws);
    });
    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(String(raw)) as { type?: string };
        if (parsed?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // Ignore malformed payloads.
      }
    });

    const base = req.headers.host ? `http://${req.headers.host}` : "http://localhost";
    const url = new URL(req.url ?? "/ws", base);
    const token = url.searchParams.get("token") ?? "";
    const questionId = url.searchParams.get("questionId") ?? "";

    void authenticate(ws, {
      token,
      questionId: questionId.length > 0 ? questionId : null,
    });
  });

  const heartbeat = setInterval(() => {
    socketServer.clients.forEach((rawSocket) => {
      const ws = rawSocket as Client;
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  socketServer.on("close", () => clearInterval(heartbeat));

  return socketServer;
}

async function authenticate(ws: Client, data: RealtimeData) {
  try {
    if (!data.token) {
      ws.close(4401, "unauthorized");
      return;
    }
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
      subscribe(ws, topicForQuestion(data.questionId));
    }

    subscribe(ws, topicForUser(user.id));
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