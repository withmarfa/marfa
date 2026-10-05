import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderAuthErrorPage } from "./test-render.js";

/**
 * `/auth/error` page renderer + route smoke. The route exists so OAuth
 * failures (chiefly `invalid_client`) land on a real page with a way back,
 * instead of better-auth core's production redirect to the JSON API root.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderAuthErrorPage", () => {
  it("uses the shared auth layout and links back to sign-in", () => {
    const html = renderAuthErrorPage("invalid_client");
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css" nonce="test-nonce">',
    );
    expect(html).toContain("Back to sign in");
    expect(html).toContain('href="/auth/sign-in"');
  });

  it("renders friendly copy for a known error code, not the raw token", () => {
    const html = renderAuthErrorPage("invalid_client");
    expect(html).toContain("recognize the app that sent you here");
    expect(html).not.toContain("invalid_client");
  });

  it("falls back to a generic message for an unknown code", () => {
    const html = renderAuthErrorPage("totally_unknown");
    expect(html).toContain("finish signing you in");
    expect(html).not.toContain("totally_unknown");
  });

  it("never reflects the raw error code into the page", () => {
    const html = renderAuthErrorPage('"><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("GET /auth/error", () => {
  it("returns 200 HTML with the friendly message and a back link", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/error?error=invalid_client",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.text();
    expect(body).toContain("Couldn't sign you in");
    expect(body).toContain('href="/auth/sign-in"');
  });
});
