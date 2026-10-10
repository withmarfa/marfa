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
const COOKIE_SECONDS = 400 * 24 * 3600;
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

/** The `Max-Age` of the session cookie an answer sets, if it sets one. */
function maxAge(res: Response, cookie: string): number | undefined {
  const name = cookie.slice(0, cookie.indexOf("="));
  const line = res.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  expect(line.split(";")[0]).toBe(cookie);
  return Number(/max-age=(\d+)/i.exec(line)?.[1]);
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
    // Not written, so the cookie the last use sent still holds.
    expect(maxAge(unrecorded, cookie)).toBeUndefined();
    const listed = (await list(c, cookie)).find((row) => row.current);
    expect(listed?.last_used_at).toBe(new Date(T0 + DAY).toISOString());
    // A week after the unrecorded use, the session is still live.
    at(T0 + DAY + 59 * SECOND + WEEK);
    expect((await use(c, cookie)).status).toBe(200);
  });

  it("sends the cookie again, to outlive the session, on each use it records", async () => {
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
    expect(sent).toMatch(/Max-Age=34560000/i);
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
    expect(maxAge(await use(c, ended), ended)).toBeUndefined();
  });

  it("sends the cookie on a refused answer to a use it records", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const cookie = await signIn(c);
    at(T0 + 5 * DAY);
    const missing = await request(
      c.app,
      "GET",
      "/items/019537a0-7b80-7000-8000-000000000000",
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);
    expect(maxAge(missing, cookie)).toBe(COOKIE_SECONDS);
  });

  it("admits both of two uses that fall due together, and the cookie outlives the session", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const signedIn = await request(c.app, "POST", "/auth/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
      headers: { origin: ORIGIN },
    });
    const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      signedIn.headers.get("set-cookie") ?? "",
    )![1]!;
    expect(maxAge(signedIn, cookie)).toBe(COOKIE_SECONDS);
    at(T0 + 2 * DAY);
    const [one, two] = await Promise.all([use(c, cookie), use(c, cookie)]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    const sent = [maxAge(one, cookie), maxAge(two, cookie)].filter(
      (age) => age !== undefined,
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const age of sent) expect(age).toBe(COOKIE_SECONDS);
    const listed = (await list(c, cookie)).find((row) => row.current)!;
    expect(Date.parse(listed.expires_at)).toBeLessThan(
      T0 + 2 * DAY + COOKIE_SECONDS * 1000,
    );
  });

  it("admits a read when the use cannot be written, and records the next use once it can", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const cookie = await signIn(c);
    const config: unknown = await (
      await request(c.app, "GET", "/config", { headers: { cookie } })
    ).json();
    const write = (headers: Record<string, string>) =>
      request(c.app, "PUT", "/config", {
        headers: { ...headers, origin: ORIGIN },
        body: config,
      });
    // The witness: the owner's browser can make this write.
    expect((await write({ cookie })).status).toBe(200);
    const runInTransaction = c.storage.runInTransaction.bind(c.storage);
    c.storage.runInTransaction = () =>
      Promise.reject(
        Object.assign(new Error("database or disk is full"), {
          code: "SQLITE_FULL",
        }),
      );
    at(T0 + 3 * DAY);
    const read = await use(c, cookie);
    expect(read.status).toBe(200);
    expect(maxAge(read, cookie)).toBeUndefined();
    // A write still meets the full disk itself.
    const refused = await write({ cookie });
    expect(refused.status).toBe(507);
    expect(refused.headers.get("x-error-code")).toBe("insufficient_storage");

    c.storage.runInTransaction = runInTransaction;
    at(T0 + 3 * DAY + MINUTE);
    const recovered = await use(c, cookie);
    expect(recovered.status).toBe(200);
    expect(maxAge(recovered, cookie)).toBe(COOKIE_SECONDS);
    expect(
      (await list(c, cookie)).find((row) => row.current)?.last_used_at,
    ).toBe(new Date(T0 + 3 * DAY + MINUTE).toISOString());
  });

  it("keeps a sign-in not to be remembered on a browser-session cookie, and its idle week on the server", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const signedIn = await request(c.app, "POST", "/auth/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD, rememberMe: false },
      headers: { origin: ORIGIN },
    });
    expect(signedIn.status).toBe(200);
    const sessionLine = signedIn.headers
      .getSetCookie()
      .find((line) => /session_token=/.test(line))!;
    expect(sessionLine).toBeDefined();
    expect(sessionLine).not.toMatch(/max-age/i);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    const session = cookie
      .split("; ")
      .find((pair) => pair.includes("session_token="))!;
    const created = (await list(c, cookie)).find((row) => row.current)!;
    expect(created.expires_at).toBe(new Date(T0 + WEEK + MINUTE).toISOString());

    at(T0 + DAY);
    const used = await use(c, cookie);
    expect(used.status).toBe(200);
    expect(maxAge(used, session)).toBeUndefined();
    const row = (await list(c, cookie)).find((r) => r.current)!;
    expect(row.last_used_at).toBe(new Date(T0 + DAY).toISOString());
    expect(row.expires_at).toBe(
      new Date(T0 + DAY + WEEK + MINUTE).toISOString(),
    );
  });

  it("refuses a request whose use fails for a reason other than the storage", async () => {
    at(T0 - DAY);
    const c = await context();
    at(T0);
    const cookie = await signIn(c);
    const runInTransaction = c.storage.runInTransaction.bind(c.storage);
    c.storage.runInTransaction = (() =>
      Promise.reject(
        new Error("not a storage fault"),
      )) as typeof c.storage.runInTransaction;
    at(T0 + DAY);
    try {
      expect((await use(c, cookie)).status).toBe(500);
    } finally {
      c.storage.runInTransaction = runInTransaction;
    }
    // The witness: the same request answers once nothing fails.
    expect((await use(c, cookie)).status).toBe(200);
  });
});
