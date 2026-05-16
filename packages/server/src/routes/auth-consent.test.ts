/**
 * T-131: smoke tests for the /auth/authorize consent route + the
 * /auth/authorize/decision proxy handler.
 *
 * Coverage:
 *   - GET /auth/authorize without a session redirects to /auth/sign-in
 *   - GET /auth/authorize 4xxs when the plugin's signed query (`sig`)
 *     or `client_id` is missing
 *   - POST /auth/authorize/decision without a session redirects to /auth/sign-in
 *
 * The end-to-end happy-path (full /oauth2/authorize → consent →
 * /oauth2/token → bearer-validate) is exercised by the curl-driven
 * sandbox smoke and the conformance suite. These tests pin the
 * Myme-owned auth-gate shape so a future refactor of the consent route
 * can't silently break unauthenticated callers.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe("GET /auth/authorize (consent page)", () => {
  it("redirects to /auth/sign-in when no session is present", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/authorize?response_type=code&client_id=client_x&redirect_uri=http%3A%2F%2Flocalhost%2F&scope=core.note%3Aread&state=s&code_challenge=c&code_challenge_method=S256&exp=1&sig=fake",
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in?return_to=");
  });

  it("400s when client_id or sig is missing", async () => {
    ctx = await createTestContext();
    // sig present, client_id missing
    const r1 = await request(
      ctx.app,
      "GET",
      "/auth/authorize?response_type=code&scope=core.note:read&sig=fake",
    );
    expect(r1.status).toBe(400);
    // client_id present, sig missing — would not have come from the plugin
    const r2 = await request(
      ctx.app,
      "GET",
      "/auth/authorize?response_type=code&client_id=client_x&scope=core.note:read",
    );
    expect(r2.status).toBe(400);
  });
});

describe("POST /auth/authorize/decision (consent decision proxy)", () => {
  it("redirects to /auth/sign-in when no session is present", async () => {
    ctx = await createTestContext();
    const body = new URLSearchParams({
      accept: "true",
      oauth_query: "response_type=code&client_id=client_x&sig=fake",
      client_id: "client_x",
    });
    const res = await ctx.app.fetch(
      new Request("http://test/auth/authorize/decision", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in");
  });

  // Full session-driven projection coverage lives in the curl-driven
  // sandbox smoke (T-131 hand-back). The above two assertions pin the
  // auth-gate shape; once a session is in place the handler delegates to
  // the plugin's /oauth2/consent which has its own test surface upstream.
});
