import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "oauth"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * The authorization and device flows need a signed-in person, which a bearer
 * client cannot supply, so they are unreachable here. What a client can
 * reach without a person is discovery, registration and the token door's
 * refusals, and those are asserted.
 */
describe("OAuth provider", () => {
  it("serves the authorization server metadata under the issuer path", async () => {
    const r = await fetch(
      `${apiUrl}/.well-known/oauth-authorization-server/auth`,
    );
    expect(r.status).toBe(200);
    const doc = (await r.json()) as Record<string, unknown>;
    // The issuer carries the server's configured base URL, which need not be
    // the loopback address the suite dials; its path is what identifies it.
    const issuer = new URL(doc.issuer as string);
    expect(issuer.pathname).toBe("/auth");
    for (const endpoint of [
      "token_endpoint",
      "authorization_endpoint",
      "registration_endpoint",
    ]) {
      const url = new URL(doc[endpoint] as string);
      expect(url.origin).toBe(issuer.origin);
      expect(url.pathname.startsWith("/auth")).toBe(true);
    }
    expect(new URL(doc.registration_endpoint as string).pathname).toBe(
      "/auth/oauth2/register",
    );
    expect(doc.response_types_supported).toContain("code");
    expect(doc.code_challenge_methods_supported).toContain("S256");
  });

  it("registers a native client dynamically and issues a client_id", async () => {
    const r = await client.registerOAuthClient({
      client_name: `conformance-${ctx.runId}`,
      application_type: "native",
      redirect_uris: ["http://127.0.0.1:9/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(r.status).toBe(201);
    await expectMatchesSchema("POST", "/auth/oauth2/register", 201, r.data);
    expect(typeof r.data.client_id).toBe("string");
    expect((r.data.client_id as string).length).toBeGreaterThan(0);
    expect(r.data.application_type).toBe("native");
    expect(r.data.redirect_uris).toEqual(["http://127.0.0.1:9/callback"]);
    expect(r.data.token_endpoint_auth_method).toBe("none");
    expect((r.data.scope as string).length).toBeGreaterThan(0);
  });

  it("registers a web client, whose redirect URI must be https and off the loopback", async () => {
    const accepted = await client.registerOAuthClient({
      client_name: `conformance-web-${ctx.runId}`,
      redirect_uris: ["https://app.example.com/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(accepted.status).toBe(201);
    expect(accepted.data.application_type).toBe("web");

    // Both halves of the rule: the scheme and the host. A loopback redirect
    // is refused even over https, which is the half a native client inverts.
    for (const uri of [
      "http://127.0.0.1:9/callback",
      "https://127.0.0.1:9/callback",
    ]) {
      const refused = await client.registerOAuthClient({
        client_name: `conformance-web-loopback-${ctx.runId}`,
        redirect_uris: [uri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      expect(refused.status, uri).toBe(400);
      expect((refused.data as { error?: string }).error, uri).toBe(
        "invalid_redirect_uri",
      );
    }
  });

  it("refuses an unparseable redirect URI with an RFC 7591 error object", async () => {
    const r = await client.registerOAuthClient({
      redirect_uris: ["not a url"],
    });
    expect(r.status).toBe(400);
    await expectMatchesSchema("POST", "/auth/oauth2/register", 400, r.data);
    const body = r.data as { error?: string; error_description?: string };
    expect(body.error).toBe("invalid_redirect_uri");
    expect(typeof body.error_description).toBe("string");
  });

  it("refuses a token request with no proof of the client", async () => {
    const r = await fetch(`${apiUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=nope&client_id=nope",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("refuses a grant type it does not support", async () => {
    const r = await fetch(`${apiUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=password&username=a&password=b&client_id=nope",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toBe("unsupported_grant_type");
  });
});
