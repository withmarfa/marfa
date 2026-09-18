/**
 * Dynamic client registration is the provider plugin's own endpoint.
 *
 * Marfa used to shadow `POST /auth/oauth2/register` with a handler of its
 * own, because the plugin's grant enum refused the device-code URN of the
 * hand-rolled device flow. The device plugin extends that enum, so the
 * plugin's registration serves and Marfa's handler is gone. Three
 * properties: an unauthenticated registration naming both grants answers
 * 201 with a public client and no secret; the row reads back through
 * Marfa's store with the grants it asked for and the default scope ceiling;
 * and the authorization-code flow completes with it, which is what a
 * registered client is for.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import {
  createTestContext,
  createTestAccount,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = `${ORIGIN}/callback`;

interface RegistrationResponse {
  client_id?: string;
  client_secret?: string;
  client_name?: string;
  grant_types?: string[];
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  error?: string;
}

async function register(
  c: TestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; body: RegistrationResponse }> {
  const res = await request(c.app, "POST", "/auth/oauth2/register", {
    body,
    headers: { origin: ORIGIN },
  });
  return {
    status: res.status,
    body: (await res.json()) as RegistrationResponse,
  };
}

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await createTestAccount(c, email, password, "Registration Test User");
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed (${String(signInRes.status)})`);
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error("sign-in: session_token cookie not found");
  return match[1];
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("POST /auth/oauth2/register through the provider plugin", () => {
  it("registers a public client for the code and device grants without a session", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const { status, body } = await register(c, {
      client_name: "Registered App",
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", DEVICE_CODE_GRANT_TYPE],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(status).toBe(201);
    expect(body.client_id).toBeTruthy();
    // Public: nothing to keep secret, so nothing is issued.
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect([...(body.grant_types ?? [])].sort()).toEqual(
      ["authorization_code", DEVICE_CODE_GRANT_TYPE].sort(),
    );
    expect(body.redirect_uris).toEqual([CALLBACK]);

    // The same row through Marfa's store, which every consent and ceiling
    // check reads.
    const row = await c.storage.oauthProvider!.getClient(body.client_id!);
    expect(row).not.toBeNull();
    expect(row!.name).toBe("Registered App");
    expect(row!.isPublic).toBe(true);
    expect(row!.redirectUris).toEqual([CALLBACK]);
    expect([...(row!.grantTypes ?? [])].sort()).toEqual(
      ["authorization_code", DEVICE_CODE_GRANT_TYPE].sort(),
    );
    // A registration that names no scope is given the default ceiling
    // rather than none.
    expect(row!.scopes).not.toBeNull();
    expect(row!.scopes!.length).toBeGreaterThan(0);
  });

  it("holds a web client to https and lets a native one use the loopback", async () => {
    // The old Marfa handler admitted a loopback http redirect for any
    // registration. The plugin admits it for a native client only, and a
    // registration that says nothing is a web client, so a CLI or a desktop
    // app has to say what it is.
    ctx = await createTestContext({});
    const web = await register(ctx, {
      client_name: "Says Nothing",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    });
    expect(web.status).toBe(400);
    expect(web.body.error).toBe("invalid_redirect_uri");
    const native = await register(ctx, {
      client_name: "Says Native",
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    });
    expect(native.status).toBe(201);
  });

  it("refuses a scope outside the allowlist", async () => {
    ctx = await createTestContext({});
    const { status, body } = await register(ctx, {
      client_name: "Reaches",
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
      scope: "core.note:read not.a.type:write",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_scope");
  });

  it("refuses a grant the server does not issue", async () => {
    ctx = await createTestContext({});
    const { status, body } = await register(ctx, {
      client_name: "Nope",
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["implicit"],
      token_endpoint_auth_method: "none",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("the authorization-code flow completes with a registered client", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const { body: registered } = await register(c, {
      client_name: "Browser App",
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const clientId = registered.client_id!;
    const cookie = await signInUser(c, "registered-flow@example.com");
    const { verifier, challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "dcr-state",
      scope: "core.note:read",
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
    expect(location).toContain("/auth/authorize?");
    const signedQuery = location.slice(location.indexOf("?") + 1);
    const decisionRes = await request(
      c.app,
      "POST",
      "/auth/authorize/decision",
      {
        form: {
          accept: "true",
          oauth_query: signedQuery,
          scopes: ["core.note:read"],
        },
        headers: { cookie, origin: ORIGIN },
      },
    );
    expect(decisionRes.status).toBe(302);
    const callback = new URL(decisionRes.headers.get("location") ?? "", ORIGIN);
    expect(callback.searchParams.get("state")).toBe("dcr-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await request(c.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      },
      headers: { origin: ORIGIN },
    });
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token?: string };
    expect(token.access_token).toBeTruthy();

    const data = await request(c.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${token.access_token ?? ""}` },
    });
    expect(data.status).toBe(200);
  });
});
