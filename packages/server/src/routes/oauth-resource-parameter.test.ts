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
 *
 * The client is registered through an authenticated session rather than
 * inserted, because a machine client's token takes its space from the person
 * who registered it and a client nobody registered gets no token at all. A
 * seeded row would exercise a shape the product cannot produce.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Sign up, verify and sign in; hand back the session cookie. */
async function signInCookie(c: TestContext): Promise<string> {
  const email = `resource-param-${Math.random().toString(36).slice(2, 10)}@marfa.so`;
  const password = "correct horse battery";
  await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Resource Param" },
    headers: { origin: ORIGIN },
  });
  await markEmailVerified(c.storage, email);
  const signIn = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  expect(signIn.status).toBe(200);
  const cookie = (signIn.headers.get("set-cookie") ?? "")
    .split(/,\s*(?=[a-zA-Z0-9_-]+=)/)
    .map((chunk) => chunk.split(";")[0])
    .find((head) => head?.includes("session_token"));
  expect(cookie).toBeTruthy();
  return cookie ?? "";
}

/** Register the confidential machine client the way the product mints one. */
async function registerConfidentialClient(
  c: TestContext,
): Promise<{ clientId: string; secret: string }> {
  const cookie = await signInCookie(c);
  const res = await request(c.app, "POST", "/auth/oauth2/register", {
    body: {
      grant_types: ["client_credentials"],
      client_name: "Resource Param Test",
      scope: "core.note:read",
    },
    headers: { origin: ORIGIN, cookie },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    client_id: string;
    client_secret: string;
  };
  return { clientId: body.client_id, secret: body.client_secret };
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
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
      authBaseUrl: base,
    });
    const { clientId, secret } = await registerConfidentialClient(ctx);

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
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { clientId, secret } = await registerConfidentialClient(ctx);

    const token = await tokenRequest(ctx, clientId, secret, {});
    expect(token.status).toBe(200);
    expect((token.body.access_token as string).startsWith("marfa_at_")).toBe(
      true,
    );
  });

  it("refuses a resource outside the accepted set with the RFC 8707 error", async () => {
    // The accepted audiences are pinned from the issuer base URL, so a
    // client cannot pick its own token audience — the escalation class
    // where a token minted under one grant is spent against another
    // audience. Refused up front, before the mint, with the error shape
    // RFC 8707 names for it.
    const base = "http://localhost:0";
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
      authBaseUrl: base,
    });
    const { clientId, secret } = await registerConfidentialClient(ctx);

    const token = await tokenRequest(ctx, clientId, secret, {
      resource: "https://evil.example.com/api",
    });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_target");
  });
});
