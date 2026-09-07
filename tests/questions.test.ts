import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { api, createAstrologer, json, registerUser, testEmail, uniqueUsername } from "./helpers";

let astrologer: Awaited<ReturnType<typeof createAstrologer>>;
let clientToken = "";
let clientEmail = "";
let questionId = "";

beforeAll(async () => {
  astrologer = await createAstrologer();
  const { db } = await import("../prisma/db");
  await db.astrologerProfile.update({
    where: { id: astrologer.profile.id },
    data: { questionPricePaise: 4900 },
  });
  clientEmail = testEmail("client");
  const res = await registerUser({
    name: "Chat Client",
    email: clientEmail,
    username: uniqueUsername(),
    password: "ClientPass1",
  });
  clientToken = (await json<{ accessToken: string }>(res)).accessToken;
});

afterAll(async () => {
  await cleanupUsers(clientEmail);
});

async function cleanupUsers(email: string) {
  const { db } = await import("../prisma/db");
  await removeUser(db, email);
}

async function removeUser(db: PrismaClient, email: string) {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return;
  const profile = await db.astrologerProfile.findUnique({ where: { userId: user.id } });
  if (profile) {
    await db.questionMessage.deleteMany({ where: { question: { astrologerId: profile.id } } });
    await db.question.deleteMany({ where: { astrologerId: profile.id } });
  }
  await db.questionMessage.deleteMany({ where: { question: { clientId: user.id } } });
  await db.question.deleteMany({ where: { clientId: user.id } });
  await db.payment.deleteMany({ where: { payerId: user.id } });
  await db.refreshToken.deleteMany({ where: { userId: user.id } });
  await db.astrologerProfile.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
}

describe("question chat", () => {
  test("client sends initial question", async () => {
    const res = await api("POST", "/questions", {
      token: clientToken,
      body: {
        astrologerId: astrologer.profile.id,
        questionText: "I keep having trouble sleeping ever since the new moon. Anything in my chart?",
        category: "Health",
      },
    });
    expect(res.status).toBe(201);
    const { question } = await json<{ question: { id: string; status: string } }>(res);
    questionId = question.id;
    expect(question.status).toBe("PendingPayment");
  });

  test("client messages create a payment intent, then settling delivers the message", async () => {
    const send = await api("POST", `/questions/${questionId}/messages`, {
      token: clientToken,
      body: { body: "It gets worse after 2am." },
    });
    expect(send.status).toBe(201);
    const intent = await json<{
      requiresPayment: boolean;
      payment: { id: string; amountPaise: number };
      question: { status: string };
    }>(send);
    expect(intent.requiresPayment).toBe(true);
    expect(intent.payment.amountPaise).toBeGreaterThan(0);

    // Not delivered yet until the payment settles.
    const before = await api("GET", `/questions/${questionId}/messages`, { token: clientToken });
    const beforeBody = await json<{ messages: unknown[] }>(before);
    expect(beforeBody.messages).toHaveLength(0);

    const complete = await api("POST", `/payments/${intent.payment.id}/complete`, {
      token: clientToken,
    });
    expect(complete.status).toBe(200);
    const settled = await json<{ message: { senderRole: string; body: string }; question: { status: string } }>(complete);
    expect(settled.message.senderRole).toBe("Client");
    expect(settled.message.body).toBe("It gets worse after 2am.");
    expect(settled.question.status).toBe("Queued");

    const list = await api("GET", `/questions/${questionId}/messages`, { token: astrologer.accessToken });
    const { messages } = await json<{ messages: { senderRole: string; body: string }[] }>(list);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.senderRole).toBe("Client");
    expect(messages[0]!.body).toBe("It gets worse after 2am.");
  });

  test("astrologer replying marks question Answered and transitions status", async () => {
    const send = await api("POST", `/questions/${questionId}/messages`, {
      token: astrologer.accessToken,
      body: { body: "The moon squares your ascendant, that explains the restless nights." },
    });
    expect(send.status).toBe(201);
    const { question, message } = await json<{
      question: { status: string };
      message: { senderRole: string };
    }>(send);
    expect(question.status).toBe("Answered");
    expect(message.senderRole).toBe("Astrologer");

    const list = await api("GET", `/questions/${questionId}/messages`, { token: clientToken });
    const body = await json<{ messages: { senderRole: string }[]; question: { status: string } }>(list);
    expect(body.messages).toHaveLength(2);
    expect(body.question.status).toBe("Answered");
  });

  test("list endpoint includes lastMessage preview", async () => {
    const res = await api("GET", "/questions", { token: astrologer.accessToken });
    const body = await json<{ questions: { id: string; lastMessage: { senderRole: string } | null }[] }>(res);
    const found = body.questions.find((q) => q.id === questionId);
    expect(found).toBeDefined();
    expect(found!.lastMessage?.senderRole).toBe("Astrologer");
  });

  test("non-participant is forbidden from reading or sending", async () => {
    const intruderEmail = testEmail("intruder");
    const intruder = await registerUser({
      name: "Intruder",
      email: intruderEmail,
      username: uniqueUsername(),
      password: "Intruder1",
    });
    const token = (await json<{ accessToken: string }>(intruder)).accessToken;

    const read = await api("GET", `/questions/${questionId}/messages`, { token });
    expect(read.status).toBe(403);

    const send = await api("POST", `/questions/${questionId}/messages`, { token, body: { body: "hi" } });
    expect(send.status).toBe(403);

    await cleanupUsers(intruderEmail);
  });

  test("legacy answer endpoint also appends a chat message", async () => {
    const soloEmail = testEmail("solo");
    const solo = await registerUser({
      name: "Solo Client",
      email: soloEmail,
      username: uniqueUsername(),
      password: "ClientPass1",
    });
    const soloToken = (await json<{ accessToken: string }>(solo)).accessToken;
    const question = await createDirect(astrologer.profile.id, soloToken);
    // Pay the first message so the question becomes answerable.
    const intent = await api("POST", `/questions/${question.id}/messages`, {
      token: soloToken,
      body: { body: "Getting it to a paid and queued state." },
    });
    const paymentId = (await json<{ payment: { id: string } }>(intent)).payment.id;
    await api("POST", `/payments/${paymentId}/complete`, { token: soloToken });

    const res = await api("PATCH", `/questions/${question.id}/answer`, {
      token: astrologer.accessToken,
      body: { answerText: "A typed answer that should also appear as a message" },
    });
    expect(res.status).toBe(200);

    const thread = await api("GET", `/questions/${question.id}/messages`, { token: soloToken });
    const body = await json<{ messages: { body: string }[] }>(thread);
    expect(body.messages).toHaveLength(2);
    expect(body.messages.at(-1)!.body).toBe("A typed answer that should also appear as a message");
    await cleanupUsers(soloEmail);
  });

  test("closed threads reject new messages", async () => {
    const soloEmail = testEmail("solo2");
    const solo = await registerUser({
      name: "Solo Client 2",
      email: soloEmail,
      username: uniqueUsername(),
      password: "ClientPass1",
    });
    const soloToken = (await json<{ accessToken: string }>(solo)).accessToken;
    const question = await createDirect(astrologer.profile.id, soloToken);
    // Pay first so the astrologer is allowed to reject a queued question.
    const intent = await api("POST", `/questions/${question.id}/messages`, {
      token: soloToken,
      body: { body: "Getting it into a rejectable state." },
    });
    const paymentId = (await json<{ payment: { id: string } }>(intent)).payment.id;
    await api("POST", `/payments/${paymentId}/complete`, { token: soloToken });

    await api("PATCH", `/questions/${question.id}/reject`, {
      token: astrologer.accessToken,
      body: { reason: "Not my area" },
    });
    const send = await api("POST", `/questions/${question.id}/messages`, {
      token: soloToken,
      body: { body: "hello?" },
    });
    expect(send.status).toBe(403);
    await cleanupUsers(soloEmail);
  });

  test("astrologer can unreject a rejected question back to queued", async () => {
    const soloEmail = testEmail("solo3");
    const solo = await registerUser({
      name: "Solo Client 3",
      email: soloEmail,
      username: uniqueUsername(),
      password: "ClientPass1",
    });
    const soloToken = (await json<{ accessToken: string }>(solo)).accessToken;
    const question = await createDirect(astrologer.profile.id, soloToken);
    const intent = await api("POST", `/questions/${question.id}/messages`, {
      token: soloToken,
      body: { body: "Getting it into a rejectable state." },
    });
    const paymentId = (await json<{ payment: { id: string } }>(intent)).payment.id;
    await api("POST", `/payments/${paymentId}/complete`, { token: soloToken });

    const rejected = await api("PATCH", `/questions/${question.id}/reject`, {
      token: astrologer.accessToken,
      body: { reason: "Not my area" },
    });
    expect(rejected.status).toBe(200);
    expect((await json<{ question: { status: string } }>(rejected)).question.status).toBe("Rejected");

    const unrejected = await api("PATCH", `/questions/${question.id}/unreject`, {
      token: astrologer.accessToken,
    });
    expect(unrejected.status).toBe(200);
    const body = await json<{ question: { status: string; rejectionReason: string | null } }>(unrejected);
    expect(body.question.status).toBe("Queued");
    expect(body.question.rejectionReason).toBeNull();

    // Client can message (creates a new payment intent) and astrologer can reply again.
    const intent2 = await api("POST", `/questions/${question.id}/messages`, {
      token: soloToken,
      body: { body: "Never mind, still curious." },
    });
    expect(intent2.status).toBe(201);
    await cleanupUsers(soloEmail);
  });

  test("unreject on a queued question is rejected with 403", async () => {
    const res = await api("PATCH", `/questions/${questionId}/unreject`, {
      token: astrologer.accessToken,
    });
    expect(res.status).toBe(403);
  });

  test("message requires a body", async () => {
    const send = await api("POST", `/questions/${questionId}/messages`, {
      token: clientToken,
      body: { body: "" },
    });
    expect(send.status).toBe(400);
  });
});

describe("payment gating", () => {
  let payerToken = "";
  let payerEmail = "";
  let paidQuestionId = "";

  beforeAll(async () => {
    payerEmail = testEmail("payer");
    const res = await registerUser({
      name: "Paying Client",
      email: payerEmail,
      username: uniqueUsername(),
      password: "ClientPass1",
    });
    payerToken = (await json<{ accessToken: string }>(res)).accessToken;
    const question = await api("POST", "/questions", {
      token: payerToken,
      body: {
        astrologerId: astrologer.profile.id,
        questionText: "Will I get the promotion this quarter based on the stars?",
        category: "Career",
      },
    });
    paidQuestionId = (await json<{ question: { id: string } }>(question)).question.id;
  });

  afterAll(async () => {
    await cleanupUsers(payerEmail);
  });

  async function createIntent(body = "Follow up question worth paying for.") {
    const send = await api("POST", `/questions/${paidQuestionId}/messages`, {
      token: payerToken,
      body: { body },
    });
    expect(send.status).toBe(201);
    return (await json<{ payment: { id: string } }>(send)).payment.id;
  }

  test("astrologer cannot see or message an unpaid question", async () => {
    const read = await api("GET", `/questions/${paidQuestionId}/messages`, { token: astrologer.accessToken });
    expect(read.status).toBe(200);
    const { messages } = await json<{ messages: unknown[] }>(read);
    expect(messages).toHaveLength(0);

    const send = await api("POST", `/questions/${paidQuestionId}/messages`, {
      token: astrologer.accessToken,
      body: { body: "Hey there!" },
    });
    expect(send.status).toBe(403);

    const list = await api("GET", "/questions", { token: astrologer.accessToken });
    const body = await json<{ questions: { id: string }[] }>(list);
    expect(body.questions.find((q) => q.id === paidQuestionId)).toBeUndefined();
  });

  test("paying the first message makes the question visible and answerable", async () => {
    const paymentId = await createIntent();
    await api("POST", `/payments/${paymentId}/complete`, { token: payerToken });

    const list = await api("GET", "/questions", { token: astrologer.accessToken });
    const body = await json<{ questions: { id: string; status: string }[] }>(list);
    expect(body.questions.find((q) => q.id === paidQuestionId)?.status).toBe("Queued");

    const send = await api("POST", `/questions/${paidQuestionId}/messages`, {
      token: astrologer.accessToken,
      body: { body: "The stars say yes, keep pushing." },
    });
    expect(send.status).toBe(201);
    const { question } = await json<{ question: { status: string } }>(send);
    expect(question.status).toBe("Answered");
  });

  test("every client message requires its own payment", async () => {
    const paymentId = await createIntent("I need one more follow up, paid again.");
    const incomplete = await api("GET", `/questions/${paidQuestionId}/messages`, { token: payerToken });
    const incompleteBody = await json<{ messages: { body: string }[] }>(incomplete);
    const countBefore = incompleteBody.messages.length;

    await api("POST", `/payments/${paymentId}/complete`, { token: payerToken });

    const after = await api("GET", `/questions/${paidQuestionId}/messages`, { token: payerToken });
    const afterBody = await json<{ messages: { body: string }[] }>(after);
    expect(afterBody.messages).toHaveLength(countBefore + 1);
    expect(afterBody.messages.at(-1)!.body).toBe("I need one more follow up, paid again.");
  });

  test("settling a payment is idempotent", async () => {
    const paymentId = await createIntent("The idempotent one, pay twice.");
    const first = await api("POST", `/payments/${paymentId}/complete`, { token: payerToken });
    expect(first.status).toBe(200);

    const again = await api("POST", `/payments/${paymentId}/complete`, { token: payerToken });
    expect(again.status).toBe(200);

    const thread = await api("GET", `/questions/${paidQuestionId}/messages`, { token: payerToken });
    const body = await json<{ messages: { body: string }[] }>(thread);
    expect(body.messages.filter((m) => m.body === "The idempotent one, pay twice.")).toHaveLength(1);
  });

  test("only the payer can complete a payment", async () => {
    const paymentId = await createIntent();
    const res = await api("POST", `/payments/${paymentId}/complete`, { token: astrologer.accessToken });
    expect(res.status).toBe(403);

    await api("POST", `/payments/${paymentId}/complete`, { token: payerToken });
  });
});

async function createDirect(astrologerId: string, token = clientToken): Promise<{ id: string }> {
  const res = await api("POST", "/questions", {
    token,
    body: {
      astrologerId,
      questionText: "Another few words to make a question long enough.",
      category: "Career",
    },
  });
  return (await json<{ question: { id: string } }>(res)).question;
}