/**
 * A browser session lasts seven days from its last use, under a controlled
 * clock. Only `Date` is faked, so the database and the event loop run as they
 * do in production while every time the server reads is the test's.
 *
 * The provider's own refresh renews a session only once its renewal is a day
 * old, so a session used within a day of sign-in still ends a week after
 * sign-in.
 * The first case tells the two apart: it is used inside that day and asked
 * again a week after sign-in, when only a clock kept from the last use admits
 * it. A use is recorded at most once a minute, and a session lasts a week and
 * that minute from its last recorded use, so it never ends inside a week of
 * its last use and always within a minute after.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.setConfig({ testTimeout: 60_000 });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const T0 = Date.parse("2026-03-02T09:00:00.000Z");
const ORIGIN = "http://localhost:0";
const EMAIL = "idle-sessions@example.com";
const PASSWORD = "correct horse battery";

let ctx: TestContext | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  await ctx?.cleanup();
  ctx = undefined;
});

async function context(): Promise<TestContext> {
  ctx = await createTestContext(
    {},
    { email: EMAIL, password: PASSWORD, name: "Idle Sessions" },
  );
  return ctx;
}

async function signIn(c: TestContext): Promise<string> {
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email: EMAIL, password: PASSWORD },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    res.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie).toBeTruthy();
  return cookie!;
}

/** One authenticated request as the browser holding `cookie`. */
async function use(c: TestContext, cookie: string): Promise<Response> {
  return request(c.app, "GET", "/owner", { headers: { cookie } });
}

interface SignIn {
  id: string;
  kind: string;
  current: boolean;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

async function list(c: TestContext, cookie: string): Promise<SignIn[]> {
  const res = await request(c.app, "GET", "/owner/sign-ins", {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: SignIn[] }).data;
}

function at(ms: number): void {
  vi.setSystemTime(ms);
}

describe("a browser session's idle week", () => {
  it("is measured from the last use, which a renewal a day after the last would not keep", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const cookie = await signIn(c);

    at(T0 + 23 * HOUR);
    expect((await use(c, cookie)).status).toBe(200);

    // A week after sign-in, six days and a day's remainder after the last use.
    at(T0 + WEEK + HOUR);
    expect((await use(c, cookie)).status).toBe(200);
  });

  it("ends a session unused for a full week, and keeps one used within it", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const idle = await signIn(c);
    const kept = await signIn(c);

    at(T0 + 3 * DAY);
    expect((await use(c, idle)).status).toBe(200);
    expect((await use(c, kept)).status).toBe(200);

    at(T0 + 3 * DAY + WEEK - SECOND);
    expect((await use(c, kept)).status).toBe(200);

    at(T0 + 3 * DAY + WEEK + MINUTE + SECOND);
    const ended = await use(c, idle);
    expect(ended.status).toBe(401);
    // The other, used a second before its week ran out, lives on.
    expect((await use(c, kept)).status).toBe(200);
  });

  it("lists the last use and an expiry a week after it", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const cookie = await signIn(c);
    at(T0 + 2 * DAY);
    const listed = (await list(c, cookie)).find((row) => row.current);
    expect(listed).toMatchObject({
      kind: "browser",
      created_at: new Date(T0).toISOString(),
      last_used_at: new Date(T0 + 2 * DAY).toISOString(),
      expires_at: new Date(T0 + 2 * DAY + WEEK + MINUTE).toISOString(),
    });
  });

  it("records a use at most once a minute, and keeps a whole week after an unrecorded one", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const cookie = await signIn(c);
    at(T0 + DAY);
    expect((await use(c, cookie)).status).toBe(200);
    // Inside the minute: admitted, not written.
    at(T0 + DAY + 59 * SECOND);
    const unrecorded = await use(c, cookie);
    expect(unrecorded.status).toBe(200);
    expect(unrecorded.headers.getSetCookie()).toEqual([]);
    const listed = (await list(c, cookie)).find((row) => row.current);
    expect(listed?.last_used_at).toBe(new Date(T0 + DAY).toISOString());
    // A week after the unrecorded use, the session is still live.
    at(T0 + DAY + 59 * SECOND + WEEK);
    expect((await use(c, cookie)).status).toBe(200);
  });

  it("sends the cookie again with a week's lifetime on each use", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const cookie = await signIn(c);
    at(T0 + 6 * DAY);
    const res = await use(c, cookie);
    expect(res.status).toBe(200);
    const sent = res.headers
      .getSetCookie()
      .find((line) => line.startsWith(cookie.slice(0, cookie.indexOf("="))));
    expect(sent, "no session cookie on a use").toBeTruthy();
    expect(sent!.split(";")[0]).toBe(cookie);
    expect(sent).toMatch(/Max-Age=604860/i);
    expect(sent).toMatch(/HttpOnly/i);
    expect(sent).toMatch(/SameSite=Lax/i);
  });

  it("does not renew a session that was ended", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const ended = await signIn(c);
    const other = await signIn(c);
    const id = (await list(c, ended)).find((row) => row.current)!.id;
    const res = await request(c.app, "DELETE", `/owner/sign-ins/${id}`, {
      headers: { cookie: other, origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect((await use(c, ended)).status).toBe(401);
    expect((await list(c, other)).map((row) => row.id)).not.toContain(id);
    expect((await use(c, ended)).headers.getSetCookie().join()).not.toMatch(
      /Max-Age=604860/i,
    );
  });
});
