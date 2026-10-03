import { afterEach, expect, it } from "vitest";
import {
  createTestAccount,
  createTestContext,
  request,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});
const origin = "http://localhost:0";
async function signIn(context: TestContext, email: string) {
  const password = "correct horse battery";
  await createTestAccount(context, email, password, "Test User");
  const response = await request(context.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin },
  });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.map((value) => value.split(";")[0]).join("; ");
}
function native(context: TestContext) {
  return context.storage as typeof context.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    __sqliteAll(sql: string): Promise<unknown[]>;
  };
}

it("refuses sign-out without clearing cookies when native session deletion fails, then retries successfully", async () => {
  ctx = await createTestContext();
  const cookie = await signIn(ctx, "owner@example.test");
  const db = native(ctx);
  const session = () =>
    request(ctx!.app, "GET", "/auth/get-session", { headers: { cookie } });
  expect(await (await session()).json()).not.toBeNull();
  const before = await db.__sqliteAll("SELECT id FROM auth_session");
  expect(before).toHaveLength(1);
  await db.__sqliteRun(
    "CREATE TRIGGER reject_session_delete BEFORE DELETE ON auth_session BEGIN SELECT RAISE(ABORT, 'session deletion refused'); END",
    [],
  );
  const signOut = () =>
    request(ctx!.app, "POST", "/auth/sign-out", {
      body: {},
      headers: { cookie, origin },
    });
  const refused = await signOut();
  expect(refused.status).toBe(500);
  expect(refused.headers.getSetCookie()).toEqual([]);
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).toEqual(before);
  expect(await (await session()).json()).not.toBeNull();
  await db.__sqliteRun("DROP TRIGGER reject_session_delete", []);
  const accepted = await signOut();
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).toEqual([]);
  expect(await (await session()).json()).toBeNull();
  expect((await signOut()).status).toBe(200);
});

it("keeps concurrent sign-out outcomes isolated between sessions", async () => {
  ctx = await createTestContext();
  const refusedCookie = await signIn(ctx, "refused@example.test");
  const acceptedCookie = await signIn(ctx, "accepted@example.test");
  const db = native(ctx);
  await db.__sqliteRun(
    "CREATE TRIGGER reject_one_session_delete BEFORE DELETE ON auth_session WHEN OLD.user_id IN (SELECT id FROM auth_user WHERE email='refused@example.test') BEGIN SELECT RAISE(ABORT, 'one session deletion refused'); END",
    [],
  );
  const signOut = (cookie: string) =>
    request(ctx!.app, "POST", "/auth/sign-out", {
      body: {},
      headers: { cookie, origin },
    });
  const [refused, accepted] = await Promise.all([
    signOut(refusedCookie),
    signOut(acceptedCookie),
  ]);
  expect(refused.status).toBe(500);
  expect(refused.headers.getSetCookie()).toEqual([]);
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).toContain("Max-Age=0");
  const session = (cookie: string) =>
    request(ctx!.app, "GET", "/auth/get-session", { headers: { cookie } });
  expect(await (await session(refusedCookie)).json()).not.toBeNull();
  expect(await (await session(acceptedCookie)).json()).toBeNull();
  await db.__sqliteRun("DROP TRIGGER reject_one_session_delete", []);
  expect((await signOut(refusedCookie)).status).toBe(200);
  expect(await (await session(refusedCookie)).json()).toBeNull();
});
