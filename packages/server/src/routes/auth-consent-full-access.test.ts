/**
 * The decision on the consent screen for the two answers it offers: full
 * access, which grants the request, and choosing access, which grants what the
 * controls posted. Either way the grant is the signed request or narrower.
 */
import { makeSignature } from "better-auth/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeOAuthQueryParams } from "../auth/narrow-signed-query.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const SECRET = "test-auth-secret-change-in-production-not-required-here";
const REGISTERED = [
  "openid",
  "core.note:read",
  "core.note:write",
  "core.task:read",
  "keys.mint",
];
const REQUESTED = "openid core.note:read core.note:write keys.mint";

interface Db {
  insert: (table: unknown) => {
    values: (v: Record<string, unknown>) => Promise<unknown>;
  };
}

async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const schema = await import("../storage/sqlite/schema.js");
  const now = new Date();
  await (c.storage.betterAuthDb as Db).insert(schema.auth_oauth_client).values({
    id: `pk_${clientId}`,
    clientId,
    name: "Full Access Client",
    redirectUris: JSON.stringify(["http://localhost:0/callback"]),
    scopes: JSON.stringify(REGISTERED),
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  return clientId;
}

async function signedQuery(clientId: string, scope: string): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:0/callback",
    scope,
    state: "s",
    code_challenge: "0123456789012345678901234567890123456789012",
    code_challenge_method: "S256",
    exp: String(Math.floor(Date.now() / 1000) + 600),
    ba_iat: String(Date.now()),
  });
  params.set(
    "sig",
    await makeSignature(
      canonicalizeOAuthQueryParams(params).toString(),
      SECRET,
    ),
  );
  return params.toString();
}

async function decide(
  c: TestContext,
  clientId: string,
  form: Record<string, string | string[]>,
): Promise<Response> {
  return request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: await signedQuery(clientId, REQUESTED),
      client_id: clientId,
      ...form,
    },
    headers: { cookie: c.owner.cookie, origin: ORIGIN },
  });
}

const grantedFor = async (c: TestContext, clientId: string) => {
  const grants = await c.storage.items.list({
    type: "system.connection",
    state: "active",
  });
  const grant = grants.data.find((g) => g.properties.client_id === clientId);
  return new Set(
    await c.storage.oauthProvider?.getPriorConsent(
      clientId,
      grant?.properties.user_id as string,
    ),
  );
};

describe("full access on the consent screen", () => {
  it("grants the whole request when the person posts no controls", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const res = await decide(ctx, clientId, { access: "full" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("code=");
    expect(await grantedFor(ctx, clientId)).toEqual(
      new Set(REQUESTED.split(" ")),
    );
  });

  it("witness: the same post without the answer grants nothing", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const res = await decide(ctx, clientId, {});
    expect(res.headers.get("location") ?? "").not.toContain("code=");
  });

  it("grants the whole request when the controls were narrowed, because the answer decides", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const res = await decide(ctx, clientId, {
      access: "full",
      scopes: ["openid", "core.note:read"],
    });
    expect(res.headers.get("location") ?? "").toContain("code=");
    expect(await grantedFor(ctx, clientId)).toEqual(
      new Set(REQUESTED.split(" ")),
    );
  });

  it("never grants more than the request, whatever the form adds", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const res = await decide(ctx, clientId, {
      access: "full",
      scopes: ["core.task:read", "webhooks.manage", "*:write"],
      types: ["core.task:read"],
    });
    expect(res.headers.get("location") ?? "").toContain("code=");
    expect(await grantedFor(ctx, clientId)).toEqual(
      new Set(REQUESTED.split(" ")),
    );
    // Witness: choosing access with the same extra literal is refused.
    const refused = await decide(ctx, clientId, {
      access: "choose",
      scopes: ["core.task:read"],
    });
    expect(refused.status).toBe(400);
  });
});

describe("choosing access on the consent screen", () => {
  it("grants only what the controls posted", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const res = await decide(ctx, clientId, {
      access: "choose",
      scopes: ["openid", "core.note:read"],
    });
    expect(res.headers.get("location") ?? "").toContain("code=");
    expect(await grantedFor(ctx, clientId)).toEqual(
      new Set(["openid", "core.note:read"]),
    );
  });

  it("reads a post with no answer as choosing, which can only narrow", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const res = await decide(ctx, clientId, {
      access: "everything",
      scopes: ["core.note:read"],
    });
    expect(res.headers.get("location") ?? "").toContain("code=");
    expect(await grantedFor(ctx, clientId)).toEqual(
      new Set(["core.note:read"]),
    );
  });
});

describe("full access and the recent sign-in rule", () => {
  /** Age the owner's session to six minutes old. */
  const agedSession = async (c: TestContext): Promise<void> => {
    const then = Math.floor(Date.now() / 1000) - 6 * 60;
    await (
      c.storage as unknown as {
        __sqliteRun: (sql: string, args: number[]) => Promise<unknown>;
      }
    ).__sqliteRun("UPDATE auth_session SET created_at = ?, updated_at = ?", [
      then,
      then,
    ]);
  };

  it("refuses full access that includes a write or a permission on an old sign-in", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    await agedSession(ctx);
    const res = await decide(ctx, clientId, { access: "full" });
    expect(res.status).toBe(403);
    expect(
      (
        await ctx.storage.items.list({
          type: "system.connection",
          state: "active",
        })
      ).data,
    ).toEqual([]);
  });

  it("grants full access to a read-only request on an old sign-in", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    await agedSession(ctx);
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        access: "full",
        oauth_query: await signedQuery(clientId, "openid core.note:read"),
        client_id: clientId,
      },
      headers: { cookie: ctx.owner.cookie, origin: ORIGIN },
    });
    expect(res.headers.get("location") ?? "").toContain("code=");
  });
});
