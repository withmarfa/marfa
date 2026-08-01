/**
 * Default-scope ceilings on the non-interactive minting paths.
 *
 * Two paths hand out authority with no consent screen in front of them,
 * and both defaulted to the entire scope allowlist — including the global
 * `*:write` wildcard — when the request simply omitted `scope`:
 *
 *  - Dynamic client registration (unauthenticated): an omitted `scope`
 *    registered the client with every requestable scope.
 *  - The `client_credentials` grant: a token request with no `scope`, for
 *    a client registered without scopes, fell back to the full allowlist.
 *    There is no user in that grant, so nothing ever reviewed it.
 *
 * The ceiling now comes from `auth/mint-ceiling.ts`: DCR defaults to the
 * bundle expansion (what a consent screen would have shown), and
 * `client_credentials` defaults to nothing — a machine client states what
 * it needs or gets no data-plane reach.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { expandBundlesToScopes } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { getPermissionBundles } from "../config.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Seed a confidential `client_credentials` client directly in storage —
 *  Marfa's DCR surface deliberately refuses to register that grant type,
 *  and the ceiling has to hold even for a client that exists by other
 *  means (an operator insert, a future admin surface, a bug). */
async function seedConfidentialClient(
  c: TestContext,
  secret: string,
): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const clientPk = `pk_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedConfidentialClient: storage.betterAuthDb missing");
  }
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  const asArray = (values: string[]): unknown =>
    c.storage.betterAuthDialect === "pg" ? values : JSON.stringify(values);
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    // The plugin stores secrets as unpadded base64url SHA-256 by default.
    clientSecret: createHash("sha256").update(secret).digest("base64url"),
    name: "M2M Test",
    redirectUris: asArray([]),
    grantTypes: asArray(["client_credentials"]),
    tokenEndpointAuthMethod: "client_secret_basic",
    public: false,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

async function clientCredentialsToken(
  c: TestContext,
  clientId: string,
  secret: string,
  scope?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const params = new URLSearchParams({ grant_type: "client_credentials" });
  if (scope !== undefined) params.set("scope", scope);
  const res = await c.app.fetch(
    new Request(`${ORIGIN}/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
        origin: ORIGIN,
      },
      body: params.toString(),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("client_credentials default-scope ceiling", () => {
  it("grants nothing when no scope is requested and the client registered none", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const secret = `s3cret-${Math.random().toString(36).slice(2)}`;
    const clientId = await seedConfidentialClient(ctx, secret);

    const token = await clientCredentialsToken(ctx, clientId, secret);
    expect(token.status).toBe(200);
    const grantedScope = (token.body.scope as string | undefined) ?? "";
    expect(grantedScope).not.toContain("*:write");
    expect(grantedScope).not.toContain("*:read");
    expect(grantedScope.trim()).toBe("");

    // No data-plane reach: a zero-scope credential cannot write.
    const accessToken = token.body.access_token as string;
    const write = await request(ctx.app, "POST", "/items", {
      key: accessToken,
      body: { type: "core.note", properties: { body: "m2m" } },
    });
    expect(write.status).toBeGreaterThanOrEqual(400);
  });

  it("still grants an explicitly requested scope", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const secret = `s3cret-${Math.random().toString(36).slice(2)}`;
    const clientId = await seedConfidentialClient(ctx, secret);

    const token = await clientCredentialsToken(
      ctx,
      clientId,
      secret,
      "core.note:read",
    );
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe("core.note:read");
  });
});

describe("lease-token scope claims are bounded", () => {
  // A lease grants no Marfa data-plane authority — its scopes are claims
  // relayed to the introspecting upstream in that service's vocabulary.
  // Nothing semantic exists to validate them against (the manifest
  // declares no per-capability scope vocabulary), so the fence is shape:
  // introspection must not be usable as an unbounded storage channel.
  it("refuses an empty-string scope and an oversized claim set", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const attempt = (scopes: string[]) =>
      request(ctx!.app, "POST", "/connections/some-id/lease-tokens", {
        key: ctx!.adminKey,
        body: { capability_id: "cap", scopes },
      });

    // Shape validation runs before connection resolution, so a
    // nonexistent connection id still exercises the bound.
    const empty = await attempt([""]);
    expect(empty.status).toBe(400);
    const oversized = await attempt(
      Array.from({ length: 33 }, (_, i) => `claim-${String(i)}`),
    );
    expect(oversized.status).toBe(400);
  });
});

describe("dynamic client registration default-scope ceiling", () => {
  it("registers the bundle expansion, not the full allowlist, on omitted scope", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code"],
        client_name: "scope-defaults",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string };
    const registered = body.scope.split(" ").filter(Boolean).sort();
    expect(registered).not.toContain("*:write");
    expect(registered).not.toContain("*:read");
    expect(registered).toEqual(
      expandBundlesToScopes(getPermissionBundles()).sort(),
    );
  });

  it("still registers wider scopes when explicitly requested", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code"],
        client_name: "scope-explicit",
        scope: "*:read *:write openid",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string };
    expect(body.scope.split(" ").sort()).toEqual(
      ["*:read", "*:write", "openid"].sort(),
    );
  });
});
