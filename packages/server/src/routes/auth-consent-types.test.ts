/**
 * The decision on the consent screen when the person chose types in place of
 * all data: the app's registration is widened to name them, and that write
 * stands or falls with the approval.
 */
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
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
const REGISTERED = ["openid", "*:read"];

interface Db {
  insert: (table: unknown) => {
    values: (v: Record<string, unknown>) => Promise<unknown>;
  };
  update: (table: unknown) => {
    set: (v: Record<string, unknown>) => {
      where: (w: unknown) => Promise<unknown>;
    };
  };
}

async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const schema = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as Db;
  const now = new Date();
  await db.insert(schema.auth_oauth_client).values({
    id: `pk_${clientId}`,
    clientId,
    name: "Types Client",
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

async function disableClient(c: TestContext, clientId: string): Promise<void> {
  const schema = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as Db;
  await db
    .update(schema.auth_oauth_client)
    .set({ disabled: true })
    .where(eq(schema.auth_oauth_client.clientId, clientId));
}

async function signIn(c: TestContext): Promise<string> {
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email: c.owner.email, password: c.owner.password },
    headers: { origin: ORIGIN },
  });
  const cookies = (res.headers.get("set-cookie") ?? "").split(
    /,\s*(?=[a-zA-Z0-9_-]+=)/,
  );
  const head = cookies
    .map((c) => c.split(";")[0])
    .find((h) => h?.includes("session_token"));
  if (!head) throw new Error("no session cookie");
  return head;
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

async function chooseTypes(c: TestContext, cookie: string, clientId: string) {
  const res = await request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: await signedQuery(clientId, REGISTERED.join(" ")),
      client_id: clientId,
      scopes: ["openid", "choose-types"],
      types: ["core.note:read"],
    },
    headers: { cookie, origin: ORIGIN },
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

const widenings = async (c: TestContext) =>
  (
    await c.storage.audit.list({
      action: "auth.client.scopes_widened",
      limit: 10,
    })
  ).data;

describe("choosing types names them in the app's registration", () => {
  it("widens the registration and records it when the provider issues the code", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signIn(ctx);
    const to = await chooseTypes(ctx, cookie, clientId);
    expect(to.searchParams.get("code")).toBeTruthy();
    expect(
      (await ctx.storage.oauthProvider?.getClient(clientId))?.scopes,
    ).toEqual([...REGISTERED, "core.note:read"]);
    expect(await widenings(ctx)).toHaveLength(1);
  });

  it("leaves the registration and the audit log as they were when the provider refuses", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signIn(ctx);
    // The witness is the test above: the same post with the app enabled widens.
    await disableClient(ctx, clientId);
    const to = await chooseTypes(ctx, cookie, clientId);
    expect(to.searchParams.get("code")).toBeNull();
    expect(to.searchParams.get("error")).toBeTruthy();
    expect(
      (await ctx.storage.oauthProvider?.getClient(clientId))?.scopes,
    ).toEqual(REGISTERED);
    expect(await widenings(ctx)).toEqual([]);
  });
});
