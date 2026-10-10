import { afterEach, expect, it } from "vitest";
import {
  createTestContext,
  expectSessionCookieKept,
  request,
  type TestContext,
} from "../test-utils.js";
import {
  withCredentialAudit,
  withCredentialRequest,
} from "./credential-adapter.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});
const origin = "http://localhost:0";
async function signIn(context: TestContext) {
  const { email, password } = context.owner;
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
  const cookie = ctx.owner.cookie;
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
  expectSessionCookieKept(refused, cookie);
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
  const refusedCookie = await signIn(ctx);
  const acceptedCookie = await signIn(ctx);
  const db = native(ctx);
  const refusedSession = await request(ctx.app, "GET", "/auth/get-session", {
    headers: { cookie: refusedCookie },
  });
  const refusedId = (
    (await refusedSession.json()) as { session: { id: string } }
  ).session.id;
  await db.__sqliteRun(
    `CREATE TRIGGER reject_one_session_delete BEFORE DELETE ON auth_session WHEN OLD.id='${refusedId.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT, 'one session deletion refused'); END`,
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
  expectSessionCookieKept(refused, refusedCookie);
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

it("refuses sign-out when native lookup cannot determine whether to delete the session, then retries successfully", async () => {
  ctx = await createTestContext();
  const cookie = ctx.owner.cookie;
  const db = native(ctx);
  const before = await db.__sqliteAll("SELECT id FROM auth_session");
  expect(before).toHaveLength(1);
  const columns = (await db.__sqliteAll("PRAGMA table_info(auth_session)")) as {
    name: string;
  }[];
  await db.__sqliteRun(
    "ALTER TABLE auth_session RENAME TO auth_session_saved",
    [],
  );
  await db.__sqliteRun(
    `CREATE VIEW auth_session AS SELECT ${columns.map(({ name }) => (name === "id" ? "json_extract('malformed', '$') AS id" : `"${name}"`)).join(",")} FROM auth_session_saved`,
    [],
  );
  const signOut = (headers: Record<string, string>) =>
    request(ctx!.app, "POST", "/auth/sign-out", {
      body: {},
      headers: { ...headers, origin },
    });
  const [refused, anonymous] = await Promise.all([
    signOut({ cookie }),
    signOut({}),
  ]);
  expect(refused.status).toBe(500);
  expectSessionCookieKept(refused, cookie);
  expect(anonymous.status).toBe(200);
  expect(await db.__sqliteAll("SELECT id FROM auth_session_saved")).toEqual(
    before,
  );
  await db.__sqliteRun("DROP VIEW auth_session", []);
  await db.__sqliteRun(
    "ALTER TABLE auth_session_saved RENAME TO auth_session",
    [],
  );
  const session = () =>
    request(ctx!.app, "GET", "/auth/get-session", { headers: { cookie } });
  expect(await (await session()).json()).not.toBeNull();
  const accepted = await signOut({ cookie });
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).toEqual([]);
  expect(await (await session()).json()).toBeNull();
});

it.each(["findOne", "findMany", "delete"] as const)(
  "retains the first %s failure if later provider operations continue",
  async (firstOperation) => {
    ctx = await createTestContext();
    const capture = (work: () => Promise<Response>) =>
      withCredentialRequest({ path: "/sign-out", clientIp: null }, work);
    let failure: Error | undefined = new Error("first session failure");
    const original = (args: { model: string; where: unknown[] }) => {
      expect(args.model).toBe("session");
      return failure ? Promise.reject(failure) : Promise.resolve(null);
    };
    const adapter = withCredentialAudit(
      () => ({
        findOne: original,
        findMany: original,
        delete: original,
      }),
      ctx.storage,
    )();
    const firstFailure = failure;
    const args = { model: "session", where: [] };
    await expect(
      capture(async () => {
        await adapter[firstOperation](args).catch(() => undefined);
        failure = new Error("later session failure");
        await adapter.delete(args).catch(() => undefined);
        failure = undefined;
        await adapter.findMany(args);
        return new Response(null, { status: 200 });
      }),
    ).rejects.toBe(firstFailure);
    failure = firstFailure;
    await expect(
      capture(async () => {
        await adapter[firstOperation](args).catch(() => undefined);
        throw new Error("later provider exception");
      }),
    ).rejects.toBe(firstFailure);
    failure = undefined;
    expect(
      (
        await capture(async () => {
          await adapter.findMany(args);
          return new Response(null, { status: 200 });
        })
      ).status,
    ).toBe(200);
  },
);

it("audits an update of a session row other than a recorded use", async () => {
  ctx = await createTestContext();
  const row = { id: "session-audit-probe", userId: ctx.owner.id };
  const adapter = withCredentialAudit(
    () => ({
      findOne: (args: { model: string }) =>
        Promise.resolve(args.model === "session" ? row : null),
      findMany: (args: { model: string }) =>
        Promise.resolve(args.model === "session" ? [row] : []),
      update: (args: { model: string }) =>
        Promise.resolve(args.model === "session" ? row : null),
      updateMany: (args: { model: string }) =>
        Promise.resolve(args.model === "session" ? 1 : 0),
    }),
    ctx.storage,
  )();
  const audited = async (action: string) =>
    (await ctx!.storage.audit.list({ action })).data.length;
  const args = { model: "session", where: [], update: {} };
  await withCredentialRequest({ path: "/sign-out", clientIp: null }, () =>
    adapter.update(args),
  );
  await withCredentialRequest({ path: "/sign-out", clientIp: null }, () =>
    adapter.updateMany(args),
  );
  expect(await audited("auth.session.update")).toBe(1);
  expect(await audited("auth.session.updateMany")).toBe(1);
  // A recorded use is the one update left out.
  await withCredentialRequest(
    { path: "/use-session", clientIp: null, recordsSessionUse: true },
    () => adapter.update(args),
  );
  expect(await audited("auth.session.update")).toBe(1);
});
