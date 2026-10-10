/**
 * The non-interactive minting paths: one ceiling, and one grant that is
 * gone.
 *
 * Dynamic client registration hands out a scope ceiling with no consent
 * screen in front of it. The provider plugin's registration stores one
 * ceiling for every client it registers, the server's allowlist, whatever
 * the request named or omitted: a request outside the allowlist is refused,
 * and a narrower one does not narrow the row. What a self-registered client
 * may later ask for is therefore exactly what the discovery document
 * advertises, and the consent screen is the only narrowing. Marfa's own
 * registration handler used to store the bundle expansion for an omitted
 * scope and the literals for a named one; that went with the handler, and
 * the two cases below pin what replaced it so a plugin upgrade that changes
 * the rule is a change the suite sees.
 *
 * The `client_credentials` grant was the other such path and it is no longer
 * a grant this server has. A machine acting on this server uses an API key,
 * listed, narrowed, revoked and rotated through the key routes;
 * a machine token has none of that, and it would hold permissions no
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
import { SESSION_CRITICAL_SCOPES } from "../auth/mint-ceiling.js";

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
  const schemaModule = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  const asArray = (values: string[]): unknown => JSON.stringify(values);
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
    ctx = await createTestContext({});
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
    ctx = await createTestContext({});
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

/** The scopes the server advertises, which is the allowlist a registration
 *  is held to. */
async function advertisedScopes(c: TestContext): Promise<string[]> {
  const res = await request(
    c.app,
    "GET",
    "/.well-known/oauth-authorization-server/auth",
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { scopes_supported?: string[] };
  return [...(body.scopes_supported ?? [])].sort();
}

describe("dynamic client registration scope ceiling", () => {
  it("registers the advertised allowlist as the ceiling on omitted scope", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        application_type: "native",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code"],
        client_name: "scope-defaults",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string };
    const registered = body.scope.split(" ").filter(Boolean).sort();
    // The whole allowlist, wildcards included, and the session scopes with
    // it: a ceiling minted without `offline_access` refuses the client's
    // first authorize for a literal it was never told to name.
    expect(registered).toEqual(await advertisedScopes(ctx));
    expect(registered).toContain("*:write");
    for (const scope of SESSION_CRITICAL_SCOPES) {
      expect(registered).toContain(scope);
    }
    // And the bundle expansion, which is what a consent screen offers by
    // default, sits inside it.
    for (const scope of expandBundlesToScopes(getPermissionBundles())) {
      expect(registered).toContain(scope);
    }
  });

  it("registers a narrower request at the scope it asked for, and refuses one outside the allowlist", async () => {
    ctx = await createTestContext({});
    const narrow = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        application_type: "native",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code"],
        client_name: "scope-narrow",
        scope: "core.note:read openid core.note:read",
      },
    });
    expect(narrow.status).toBe(201);
    const body = (await narrow.json()) as { client_id: string; scope: string };
    // The answer and the stored row both say what was asked for, once each,
    // and neither says the catalog the plugin stores by default.
    expect(body.scope).toBe("core.note:read openid");
    const stored = await ctx.storage.oauthProvider?.getClient(body.client_id);
    expect(stored?.scopes).toEqual(["core.note:read", "openid"]);
    expect((await advertisedScopes(ctx)).length).toBeGreaterThan(2);

    const outside = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        application_type: "native",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code"],
        client_name: "scope-outside",
        scope: "core.note:read not.a.type:write",
      },
    });
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { error?: string }).error).toBe(
      "invalid_scope",
    );
  });
});
