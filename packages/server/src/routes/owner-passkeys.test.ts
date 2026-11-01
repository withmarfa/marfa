import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createClaimTestApp } from "../auth/claim-test-app.js";
import { testAuthenticator } from "../auth/passkey-test-authenticator.js";
import { directAuthorityMiddleware } from "../middleware/direct-authority.js";
import { createErrorHandler } from "../middleware/error-handler.js";
import { ownerRoutes } from "./owner.js";
import type { AppEnv } from "../middleware/auth.js";
const origin = "http://localhost:8600";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const cookies = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
async function fixture() {
  const ctx = await createClaimTestApp(origin);
  cleanups.push(ctx.cleanup);
  const owner = {
    email: "owner@example.com",
    password: "correct horse battery",
  };
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = ownerCookie,
    extra = {},
  ) =>
    ctx.app.request(origin + path, {
      method,
      headers: { origin, cookie, "content-type": "application/json", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let ownerCookie = "";
  expect(
    (await request("/owner", "POST", { ...owner, code: ctx.setupCode })).status,
  ).toBe(201);
  ownerCookie = cookies(await request("/auth/sign-in/email", "POST", owner));
  const register = async (name?: string) => {
    const options = await request("/auth/passkey/generate-register-options");
    const device = testAuthenticator();
    const response = await request(
      "/auth/passkey/verify-registration",
      "POST",
      {
        response: device.registration(
          ((await options.json()) as { challenge: string }).challenge,
          origin,
        ),
        ...(name === undefined ? {} : { name }),
      },
      ownerCookie + "; " + cookies(options),
    );
    expect(response.status).toBe(200);
    return { device, row: (await response.json()) as { id: string } };
  };
  const local = new Hono<AppEnv>();
  local.onError(createErrorHandler({ errorWebhookUrl: "" }));
  local.use(
    "*",
    directAuthorityMiddleware(ctx.storage, ctx.auth, origin, true),
  );
  local.route("/owner", ownerRoutes(ctx.storage, ctx.auth));
  return { ...ctx, ownerCookie, request, register, local };
}
it("lists safe unnamed credentials, renames and removes through browser and local authority", async () => {
  const ctx = await fixture();
  const { row } = await ctx.register();
  const response = await ctx.request("/owner/passkeys");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: unknown[];
    next_cursor: null;
  };
  expect(body).toEqual({
    data: [
      {
        id: row.id,
        name: null,
        created_at: expect.any(String),
        last_used_at: null,
      },
    ],
    next_cursor: null,
  });
  const rename = await ctx.request(`/owner/passkeys/${row.id}`, "PATCH", {
    name: "  Studio  ",
  });
  expect(rename.status).toBe(200);
  expect(await rename.json()).toMatchObject({ id: row.id, name: "Studio" });
  expect(
    (await ctx.local.request(`/owner/passkeys/${row.id}`, { method: "DELETE" }))
      .status,
  ).toBe(200);
  const missing = await ctx.request(`/owner/passkeys/${row.id}`, "DELETE");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({
    error: { code: "passkey_not_found" },
  });
  expect((await ctx.request("/owner/passkeys")).status).toBe(200);
});
it("rejects invalid names, foreign IDs, wrong origins and bearer authority without changing credentials", async () => {
  const ctx = await fixture();
  const { row } = await ctx.register("Kept");
  for (const name of [
    " ",
    "a".repeat(201),
    "bad\u0000name",
    "bad\u202ename",
    "\nName",
    "Name\n",
    "bad\u061cname",
    "bad\u200ename",
  ])
    expect(
      (await ctx.request(`/owner/passkeys/${row.id}`, "PATCH", { name }))
        .status,
    ).toBe(400);
  expect(
    (
      await ctx.request(`/owner/passkeys/${row.id}`, "PATCH", {
        name: "Okay",
        other: true,
      })
    ).status,
  ).toBe(400);
  expect((await ctx.request("/owner/passkeys/unknown", "DELETE")).status).toBe(
    404,
  );
  expect(
    (
      await ctx.request(
        `/owner/passkeys/${row.id}`,
        "DELETE",
        undefined,
        ctx.ownerCookie,
        { origin: "https://elsewhere.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await ctx.request("/owner/passkeys", "GET", undefined, ctx.ownerCookie, {
        authorization: "Bearer anything",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await ctx.request("/owner/passkeys", "GET", undefined, "", {
        "x-marfa-local": "true",
      })
    ).status,
  ).toBe(401);
  const db = ctx.storage.betterAuthDb as {
    run(query: unknown): Promise<unknown>;
  };
  const foreign = await ctx.auth.createEmailAccount({
    email: "foreign@example.com",
    password: "another strong password",
  });
  if (!foreign.ok) throw new Error("missing foreign user");
  await db.run(
    sql`update auth_passkey set user_id = ${foreign.authUserId} where id = ${row.id}`,
  );
  expect(
    (await ctx.request(`/owner/passkeys/${row.id}`, "DELETE")).status,
  ).toBe(404);
});
it("refuses a name at registration by the rule the rename holds, before anything is stored", async () => {
  const ctx = await fixture();
  const options = await ctx.request("/auth/passkey/generate-register-options");
  const challenge = ((await options.json()) as { challenge: string }).challenge;
  const cookie = ctx.ownerCookie + "; " + cookies(options);
  const response = testAuthenticator().registration(challenge, origin);
  const attempt = (name: unknown) =>
    ctx.request(
      "/auth/passkey/verify-registration",
      "POST",
      { response, name },
      cookie,
    );
  for (const name of [
    "",
    " ",
    "a".repeat(201),
    "a".repeat(509),
    "bad\u0000name",
    "\u001b[31mred\u001b[0m",
    "bad\u202ename",
    "bad\u061cname",
    "bad\u200ename",
    "\nName",
    "Name\n",
    123,
    null,
  ]) {
    const refused = await attempt(name);
    expect(refused.status, JSON.stringify(name)).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  }
  expect(await (await ctx.request("/owner/passkeys")).json()).toMatchObject({
    data: [],
  });
  // The refusals spent nothing: the same challenge still registers.
  const accepted = await attempt("  Studio  ");
  expect(accepted.status).toBe(200);
  expect(await (await ctx.request("/owner/passkeys")).json()).toMatchObject({
    data: [{ name: "Studio" }],
  });
});
it("requires recent authentication for mutations but permits stale reads and local changes", async () => {
  const ctx = await fixture();
  const { row } = await ctx.register("Owner");
  const session = await ctx.auth.getSession(
    new Headers({ cookie: ctx.ownerCookie }),
  );
  const db = ctx.storage.betterAuthDb as {
    run(query: unknown): Promise<unknown>;
  };
  for (const seconds of [-3600, 3600]) {
    await db.run(
      sql`update auth_session set created_at = ${Math.floor(Date.now() / 1000) + seconds} where id = ${session!.session.id}`,
    );
    expect((await ctx.request("/owner/passkeys")).status).toBe(200);
    expect(
      (
        await ctx.request(`/owner/passkeys/${row.id}`, "PATCH", {
          name: "Refused",
        })
      ).status,
    ).toBe(403);
    expect(
      (await ctx.request(`/owner/passkeys/${row.id}`, "DELETE")).status,
    ).toBe(403);
  }
  expect(
    (await ctx.local.request(`/owner/passkeys/${row.id}`, { method: "DELETE" }))
      .status,
  ).toBe(200);
});
it("rolls back rename and removal when audit storage refuses the transaction", async () => {
  const ctx = await fixture();
  const { row } = await ctx.register("Kept");
  const original = ctx.storage.audit.log.bind(ctx.storage.audit);
  vi.spyOn(ctx.storage.audit, "log").mockImplementation(async (entry, id) => {
    if (entry.resource_type === "auth_passkey")
      throw new Error("audit unavailable");
    return original(entry, id);
  });
  expect(
    (await ctx.request(`/owner/passkeys/${row.id}`, "PATCH", { name: "Lost" }))
      .status,
  ).toBe(500);
  expect(
    (await ctx.request(`/owner/passkeys/${row.id}`, "DELETE")).status,
  ).toBe(500);
  expect(await (await ctx.request("/owner/passkeys")).json()).toMatchObject({
    data: [{ id: row.id, name: "Kept" }],
  });
});

it("fences provider management and keeps local URL issuance private", async () => {
  const ctx = await fixture();
  await ctx.register("Witness");
  for (const [path, method] of [
    ["list-user-passkeys", "GET"],
    ["delete-passkey", "POST"],
    ["update-passkey", "POST"],
  ] as const) {
    expect(
      (
        await ctx.request(
          "/auth/passkey/" + path,
          method,
          method === "GET" ? undefined : { id: "missing", name: "Name" },
        )
      ).status,
    ).toBe(404);
  }
});

it("rechecks a browser revoked between admission and the management write", async () => {
  const ctx = await fixture();
  const { row } = await ctx.register("Kept");
  const session = await ctx.auth.getSession(
    new Headers({ cookie: ctx.ownerCookie }),
  );
  const original = ctx.storage.runInTransaction.bind(ctx.storage);
  let revoke = true;
  vi.spyOn(ctx.storage, "runInTransaction").mockImplementation(
    async (work, options) => {
      if (revoke) {
        revoke = false;
        const db = ctx.storage.betterAuthDb as {
          run(query: unknown): Promise<unknown>;
        };
        await db.run(
          sql`delete from auth_session where id = ${session!.session.id}`,
        );
      }
      return original(work, options);
    },
  );
  expect(
    (await ctx.request(`/owner/passkeys/${row.id}`, "DELETE")).status,
  ).toBe(401);
  expect(
    await (await ctx.local.request("/owner/passkeys")).json(),
  ).toMatchObject({ data: [{ id: row.id, name: "Kept" }] });
});

import * as clock from "../clock.js";
import { createTestContext } from "../test-utils.js";
it("accepts exactly five minutes and refuses the next millisecond", async () => {
  const ctx = await fixture();
  const { row } = await ctx.register("Boundary");
  const session = await ctx.auth.getSession(
    new Headers({ cookie: ctx.ownerCookie }),
  );
  const now = vi
    .spyOn(clock, "nowMs")
    .mockReturnValue(session!.session.createdAt.getTime() + 300_000);
  expect(
    (
      await ctx.request(`/owner/passkeys/${row.id}`, "PATCH", {
        name: "Accepted",
      })
    ).status,
  ).toBe(200);
  now.mockReturnValue(session!.session.createdAt.getTime() + 300_001);
  expect(
    (
      await ctx.request(`/owner/passkeys/${row.id}`, "PATCH", {
        name: "Refused",
      })
    ).status,
  ).toBe(403);
});
it("refuses valid remote keys even beside the owner's browser cookie", async () => {
  const ctx = await createTestContext({ authBaseUrl: origin });
  cleanups.push(ctx.cleanup);
  expect((await ctx.ownerRequest("/owner/passkeys")).status).toBe(200);
  for (const cookie of ["", ctx.owner.cookie])
    for (const [method, path] of [
      ["GET", "/owner/passkeys"],
      ["PATCH", "/owner/passkeys/missing"],
      ["DELETE", "/owner/passkeys/missing"],
    ] as const) {
      const response = await ctx.app.request(origin + path, {
        method,
        headers: {
          origin,
          cookie,
          authorization: `Bearer ${ctx.managementKey}`,
          "content-type": "application/json",
        },
        ...(method === "PATCH"
          ? { body: JSON.stringify({ name: "Name" }) }
          : {}),
      });
      expect(response.status).toBe(403);
    }
});
