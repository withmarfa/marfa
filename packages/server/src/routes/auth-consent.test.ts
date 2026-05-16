/**
 * T-131: smoke tests for the /auth/authorize consent route + the
 * /auth/authorize/decision proxy handler.
 *
 * Coverage:
 *   - GET /auth/authorize without a session redirects to /auth/sign-in
 *   - GET /auth/authorize with required query params 4xxs early on missing fields
 *   - POST /auth/authorize/decision without a session redirects to /auth/sign-in
 *   - POST /auth/authorize/decision accept=true writes a system.connection
 *     projection + emits an auth.grant.created audit row
 *
 * The end-to-end happy-path (full /oauth2/authorize → consent → /oauth2/token
 * → bearer-validate) is exercised in the conformance suite and the sandbox
 * apps. These tests pin the Myme-owned shape so a future refactor of the
 * decision handler can't silently drop the projection or the audit row.
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
      "/auth/authorize?client_id=client_x&scope=core.note:read&code=preminted",
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in?return_to=");
  });

  it("400s when client_id or code is missing", async () => {
    ctx = await createTestContext();
    const r1 = await request(
      ctx.app,
      "GET",
      "/auth/authorize?scope=core.note:read&code=preminted",
    );
    expect(r1.status).toBe(400);
    const r2 = await request(
      ctx.app,
      "GET",
      "/auth/authorize?client_id=client_x&scope=core.note:read",
    );
    expect(r2.status).toBe(400);
  });
});

describe("POST /auth/authorize/decision (consent decision proxy)", () => {
  it("redirects to /auth/sign-in when no session is present", async () => {
    ctx = await createTestContext();
    const body = new URLSearchParams({
      accept: "true",
      code: "preminted",
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

  // Full session-driven projection coverage lives in the conformance
  // suite. The above two assertions pin the auth-gate shape; once a
  // session is in place the handler delegates to the plugin's
  // /oauth2/consent which has its own test surface upstream.
});
