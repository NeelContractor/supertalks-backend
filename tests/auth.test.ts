import { test, expect, afterAll, beforeAll } from "bun:test";
import {
  registerUser,
  signinUser,
  testEmail,
  uniqueUsername,
  cleanupUsers,
  getBaseUrl,
  json,
} from "./helpers";

interface RegisterBody {
  user: { email: string };
  accessToken?: string;
  refreshToken?: string;
}
interface ErrorBody {
  error?: string;
  details?: { password?: string[] };
}

let email: string;
const password = "StrongPass1";

beforeAll(() => {
  email = testEmail("auth");
});

afterAll(async () => {
  await cleanupUsers(email);
});

test("register creates a client user and returns tokens", async () => {
  const res = await registerUser({
    name: "Auth Tester",
    email,
    username: uniqueUsername(),
    password,
  });
  expect(res.status).toBe(201);

  const body = await json<RegisterBody>(res);
  expect(body.user.email).toBe(email);
  expect(typeof body.accessToken).toBe("string");
  expect(typeof body.refreshToken).toBe("string");
});

test("register rejects a weak password via contracts schema", async () => {
  const res = await registerUser({
    name: "Bad Pass",
    email: testEmail("weak"),
    username: uniqueUsername(),
    password: "lowercaseonly",
  });
  expect(res.status).toBe(400);
  const body = await json<ErrorBody>(res);
  expect(body.error).toBe("Validation failed");
  expect(body.details?.password).toBeDefined();
});

test("register rejects duplicate email with 409", async () => {
  const res = await registerUser({
    name: "Auth Tester",
    email,
    username: uniqueUsername(),
    password,
  });
  expect(res.status).toBe(409);
  const body = await json<ErrorBody>(res);
  expect(body.error).toContain("email");
});

test("signin with email works and validates credentials", async () => {
  const ok = await signinUser(email, password);
  expect(ok.status).toBe(200);
  const okBody = await json<RegisterBody>(ok);
  expect(okBody.user.email).toBe(email);

  const bad = await signinUser(email, "WrongPass1");
  expect(bad.status).toBe(401);
  const badBody = await json<ErrorBody>(bad);
  expect(badBody.error).toBe("Invalid email or password");
});

test("hello endpoint responds", async () => {
  const res = await fetch(`${getBaseUrl()}/api/hello`);
  expect(res.status).toBe(200);
  const body = await json<{ message: string }>(res);
  expect(body.message).toBe("Hello World");
});
