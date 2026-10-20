import { afterEach, expect, it, vi } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.setConfig({ testTimeout: 60_000 });

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

interface Sql {
  __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
}

async function signIn(c: TestContext): Promise<string> {
  const response = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email: c.owner.email, password: c.owner.password },
    headers: { origin: ORIGIN },
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

function end(c: TestContext, id: string, cookie: string): Promise<Response> {
  return request(c.app, "DELETE", `/owner/sign-ins/${id}`, {
    headers: { origin: ORIGIN, cookie },
  });
}

async function browsers(c: TestContext, cookie: string) {
  const listed = await request(c.app, "GET", "/owner/sign-ins", {
    headers: { origin: ORIGIN, cookie },
  });
  return (
    (await listed.json()) as {
      data: { id: string; kind: string; current?: boolean }[];
    }
  ).data.filter((row) => row.kind === "browser");
}

it("lets a stale browser session sign itself out in one request, and ends another only with a recent one", async () => {
  ctx = await createTestContext();
  const stale = ctx.owner.cookie;
  await (ctx.storage as unknown as Sql).__sqliteRun(
    "UPDATE auth_session SET created_at = ?",
    [Math.floor(Date.now() / 1000) - 6 * 60],
  );
  const fresh = await signIn(ctx);
  const rows = await browsers(ctx, stale);
  const own = rows.find((row) => row.current);
  const other = rows.find((row) => !row.current);
  expect(own && other).toBeTruthy();

  // Another session still needs a recent sign-in, and is left alone.
  expect((await end(ctx, other!.id, stale)).status).toBe(403);
  expect((await browsers(ctx, fresh)).length).toBe(2);

  // Its own it ends at once, and the cookie it holds is cleared.
  const ended = await end(ctx, own!.id, stale);
  expect(ended.status).toBe(200);
  expect(ended.headers.get("set-cookie") ?? "").toContain("session_token=;");
  expect(
    (
      await request(ctx.app, "GET", "/owner/sign-ins", {
        headers: { origin: ORIGIN, cookie: stale },
      })
    ).status,
  ).toBe(401);
  expect((await browsers(ctx, fresh)).length).toBe(1);
});
