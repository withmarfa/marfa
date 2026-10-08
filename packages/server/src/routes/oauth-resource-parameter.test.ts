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
 * JWT-format access token that the opaque-token middleware cannot resolve, a
 * token that verifies nowhere.
 *
 * **Driven through the authorization-code grant.** This suite used to seed a
 * confidential client and mint through `client_credentials`, which was the
 * cheapest way to reach the token endpoint. That grant is gone: a machine
 * acting on this server uses an API key, and a machine token would carry
 * nothing on the security page and no way for the person
 * accountable for it to end it. So the client registers the way a real MCP
 * client registers, through dynamic registration carrying a signed-in
 * session, and the code flow runs end to end. That is slower, and it is also
 * the path the parameter is actually sent on.
 */

import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";

// Each case signs a user up and in and drives a full grant before it asserts
// anything, which is real work to fit inside the default budget with the rest
// of the suite beside it. An overrun reports as a timeout, a result that says
// nothing about the property under test.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";
const SCOPE = "core.note:read";

async function signInUser(c: TestContext): Promise<string> {
  const { email, password } = c.owner;
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed (${String(signInRes.status)})`);
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

/** Register through the plugin's registration endpoint with the person's
 *  session on the request. A loopback http redirect is a native client's
 *  shape, which is what the plugin's registration accepts it for, and the
 *  plugin registers a confidential client unless told otherwise, so the
 *  public one this flow exchanges as has to say so. */
async function registerClient(c: TestContext, cookie: string): Promise<string> {
  const res = await request(c.app, "POST", "/auth/oauth2/register", {
    body: {
      application_type: "native",
      token_endpoint_auth_method: "none",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: "Resource Param Test",
      scope: SCOPE,
    },
    headers: { cookie, origin: ORIGIN },
  });
  if (res.status !== 201) {
    throw new Error(`registration failed (${String(res.status)})`);
  }
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

/**
 * Authorize, accept at the consent screen, exchange the code. `extra` is
 * merged into the token request, which is where the `resource` under test
 * goes.
 */
async function authorizationCodeGrant(
  c: TestContext,
  clientId: string,
  cookie: string,
  extra: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "resource-state",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorizeRes = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${params.toString()}`,
    { headers: { cookie } },
  );
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("location") ?? "";
  if (!location.includes("/auth/authorize?")) {
    throw new Error(`authorize did not reach consent: ${location}`);
  }
  const signedQuery = location.slice(location.indexOf("?") + 1);
  const decisionRes = await request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: signedQuery,
      scopes: SCOPE.split(" ").filter(Boolean),
    },
    headers: { cookie, origin: ORIGIN },
  });
  expect(decisionRes.status).toBe(302);
  const code = new URL(
    decisionRes.headers.get("location") ?? "",
    ORIGIN,
  ).searchParams.get("code");
  if (!code) throw new Error("no code on callback redirect");

  const tokenRes = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      ...extra,
    },
    headers: { origin: ORIGIN },
  });
  return {
    status: tokenRes.status,
    body: (await tokenRes.json()) as Record<string, unknown>,
  };
}

/** A signed-in person and a client they registered, on a fresh context.
 *  Assigns `ctx` so the file-level `afterEach` tears it down. */
async function signedInClient(
  base: string,
  email: string,
): Promise<{ context: TestContext; clientId: string; cookie: string }> {
  const context = await createTestContext(
    {
      authBaseUrl: base,
    },
    { email, password: "test resource owner password", name: "Resource Owner" },
  );
  ctx = context;
  const cookie = await signInUser(context);
  return { context, clientId: await registerClient(context, cookie), cookie };
}

describe("resource parameter on the token endpoint", () => {
  it("accepts the API origin as the resource and mints a resolvable token", async () => {
    const base = "http://localhost:0";
    const { context, clientId, cookie } = await signedInClient(
      base,
      "resource-origin@marfa.so",
    );

    const token = await authorizationCodeGrant(context, clientId, cookie, {
      resource: base,
    });
    expect(token.status, JSON.stringify(token.body)).toBe(200);

    const accessToken = token.body.access_token as string;
    // The mint must stay in the opaque family the bearer middleware
    // resolves. A JWT here is a token that verifies nowhere.
    expect(accessToken.startsWith("marfa_at_")).toBe(true);

    // And it resolves against the data plane, which is the half a shape
    // assertion cannot see: the token resolves to a principal the data
    // plane can narrow by.
    const read = await request(context.app, "GET", "/items", {
      key: accessToken,
    });
    expect(read.status).toBe(200);
  });

  it("still mints identically when no resource is sent", async () => {
    const base = "http://localhost:0";
    const { context, clientId, cookie } = await signedInClient(
      base,
      "resource-none@marfa.so",
    );

    const token = await authorizationCodeGrant(context, clientId, cookie, {});
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    expect((token.body.access_token as string).startsWith("marfa_at_")).toBe(
      true,
    );
  });

  it("refuses a resource outside the accepted set with the RFC 8707 error", async () => {
    // The accepted audiences are pinned from the issuer base URL, so a
    // client cannot pick its own token audience: the escalation class where
    // a token minted under one grant is spent against another audience.
    // Refused up front, before the mint, with the error shape RFC 8707 names
    // for it.
    const base = "http://localhost:0";
    const { context, clientId, cookie } = await signedInClient(
      base,
      "resource-evil@marfa.so",
    );

    const token = await authorizationCodeGrant(context, clientId, cookie, {
      resource: "https://evil.example.com/api",
    });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_target");
  });
});
