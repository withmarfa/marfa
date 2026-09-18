/**
 * The non-interactive minting paths: one ceiling, and one grant that is
 * gone.
 *
 * Dynamic client registration hands out authority with no consent screen in
 * front of it, and it used to default to the entire scope allowlist,
 * including the global `*:write` wildcard, when the request simply omitted
 * `scope`. The ceiling now comes from `auth/mint-ceiling.ts`: the bundle
 * expansion, which is what a consent screen would have shown.
 *
 * The `client_credentials` grant was the other such path and it is no longer
 * a grant this server has. A machine acting on a space is an API key, minted
 * into that space and listed, narrowed, revoked and rotated on the keys page;
 * a machine token has none of that, and it would hold space permissions no
 * screen ever showed anybody. Registration refuses the grant and the token
 * endpoint answers `unsupported_grant_type`, which is what the first block
 * below pins, against a client seeded past registration so the refusal is
 * shown to rest on the endpoint rather than on the registration door.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { expandBundlesToScopes } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { getPermissionBundles } from "../config.js";
import { withSessionScopes } from "../auth/mint-ceiling.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Seed a confidential `client_credentials` client directly in storage.
 *  Marfa's DCR surface refuses to register that grant type, so the only way
 *  to hold the token endpoint to its own answer is to put a client in front
 *  of it that registration would never have produced: an operator insert, a
 *  row predating the removal, or a bug. */
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
  /** Spelled out so a case can send a padded value and prove the guard
   *  normalizes before it compares. */
  grantType = "client_credentials",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const params = new URLSearchParams({ grant_type: grantType });
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

describe("the client-credentials grant is not one this server has", () => {
  it("refuses the token request with unsupported_grant_type", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const secret = `s3cret-${Math.random().toString(36).slice(2)}`;
    const clientId = await seedConfidentialClient(ctx, secret);

    // The client authenticates correctly and asks for a scope the server
    // publishes, so nothing before the grant check turns it away. What is
    // being pinned is that the endpoint refuses the grant itself rather than
    // minting a token that would reach nothing, which a client cannot tell
    // from a working credential until its first data call fails.
    const token = await clientCredentialsToken(
      ctx,
      clientId,
      secret,
      "core.note:read",
    );
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("unsupported_grant_type");
    expect(token.body.access_token).toBeUndefined();
  });

  it("is not stepped around by whitespace in grant_type", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const secret = `s3cret-${Math.random().toString(36).slice(2)}`;
    const clientId = await seedConfidentialClient(ctx, secret);

    // The endpoint matches `grant_type` against the grants this server has,
    // exactly, so a padded spelling is refused rather than dispatched to the
    // handler the padding was hiding. Pinned because the alternative shape --
    // a tolerant read of the value, or a guard bolted on in front that trims
    // where the endpoint does not -- is one where the two disagree about what
    // the request is, and the request walks between them.
    const token = await clientCredentialsToken(
      ctx,
      clientId,
      secret,
      "core.note:read",
      " client_credentials ",
    );
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("unsupported_grant_type");
    expect(token.body.access_token).toBeUndefined();
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
    // The bundle expansion plus the session scopes, which no bundle carries.
    // Asserting the expansion alone once pinned a ceiling that could not hold
    // a session: `offline_access` was absent, so the first authorize naming it
    // was refused for a literal the client was never told to register.
    expect(registered).toEqual(
      withSessionScopes(expandBundlesToScopes(getPermissionBundles())).sort(),
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
      withSessionScopes(["*:read", "*:write", "openid"]).sort(),
    );
  });
});
