/**
 * The `resource` parameter (RFC 8707) on the token endpoint.
 *
 * MCP clients MUST send `resource=<canonical MCP endpoint URI>` on both the
 * authorization and token requests, and MUST use the token only against that
 * resource. The authorization server therefore has to accept the MCP
 * endpoint's canonical URI as a valid audience AND keep minting a token the
 * bearer middleware can resolve. Neither held: the plugin's audience list
 * defaulted to the bare issuer (so the MCP URI was rejected as
 * `invalid_target`), and an accepted `resource` flipped the mint to a
 * JWT-format access token that the opaque-token middleware cannot resolve —
 * a token that verifies nowhere.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Storage-level confidential client seed, mirroring the mint-ceiling
 *  suite: Marfa's DCR refuses the client_credentials grant, so the client
 *  exists by operator insert. */
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
    clientSecret: createHash("sha256").update(secret).digest("base64url"),
    name: "Resource Param Test",
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

async function tokenRequest(
  c: TestContext,
  clientId: string,
  secret: string,
  extra: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "core.note:read",
    ...extra,
  });
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

describe("resource parameter on the token endpoint", () => {
  it("accepts the MCP endpoint's canonical URI and mints a resolvable token", async () => {
    const base = "http://localhost:0";
    ctx = await createTestContext({ authAllowSignup: false, authBaseUrl: base });
    const secret = `s3cret-${Math.random().toString(36).slice(2)}`;
    const clientId = await seedConfidentialClient(ctx, secret);

    const token = await tokenRequest(ctx, clientId, secret, {
      resource: `${base}/mcp`,
    });
    expect(token.status).toBe(200);

    const accessToken = token.body.access_token as string;
    // The mint must stay in the opaque family the bearer middleware
    // resolves — a JWT here is a token that verifies nowhere.
    expect(accessToken.startsWith("marfa_at_")).toBe(true);

    const read = await request(ctx.app, "GET", "/items", { key: accessToken });
    expect(read.status).toBe(200);
  });

  it("still mints identically when no resource is sent", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const secret = `s3cret-${Math.random().toString(36).slice(2)}`;
    const clientId = await seedConfidentialClient(ctx, secret);

    const token = await tokenRequest(ctx, clientId, secret, {});
    expect(token.status).toBe(200);
    expect((token.body.access_token as string).startsWith("marfa_at_")).toBe(true);
  });
});
