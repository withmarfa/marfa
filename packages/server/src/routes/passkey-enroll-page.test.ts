import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderPasskeyEnrollPage } from "./passkey-enroll-page.js";

/**
 * Wave C PR6 / T-034 — passkey enrol page renderer + handler smoke.
 * The full WebAuthn ceremony round-trip is browser-side and isn't
 * unit-testable here; the manual cross-browser walkthrough at the
 * end of Wave C exercises that path. This file covers:
 *   - The page renders the right shell + script tag wiring.
 *   - The route is auth-gated (302s to /auth/sign-in when no
 *     session cookie is present).
 *   - The static script (`/auth/static/passkey.js`) is served with
 *     the right content-type + ETag.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderPasskeyEnrollPage", () => {
  it("links to the shared stylesheet AND the passkey script", () => {
    const html = renderPasskeyEnrollPage({ email: "alice@example.com" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).toContain('<script src="/auth/static/passkey.js"></script>');
  });

  it("renders the email + register button + fallback paragraph", () => {
    const html = renderPasskeyEnrollPage({ email: "alice@example.com" });
    expect(html).toContain("alice@example.com");
    expect(html).toContain("Register passkey");
    expect(html).toContain('id="passkey-button"');
    expect(html).toContain('id="passkey-unsupported"');
  });

  it("escapes the email to prevent template injection", () => {
    const html = renderPasskeyEnrollPage({
      email: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes the inline click handler script", () => {
    const html = renderPasskeyEnrollPage({ email: "alice@example.com" });
    // Script body lives inline (it needs to bind to the button by id),
    // but its execution depends on `MarfaPasskey` from the static file.
    expect(html).toContain("MarfaPasskey.enroll");
    expect(html).toContain("isSupported");
  });
});

describe("GET /auth/passkey/enroll", () => {
  it("redirects to /auth/sign-in when no session cookie is present", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/passkey/enroll", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/auth\/sign-in\?return_to=/);
  });
});

describe("GET /auth/static/passkey.js", () => {
  it("serves application/javascript with ETag + cache headers", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/static/passkey.js", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/javascript/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
    const body = await res.text();
    expect(body).toContain("MarfaPasskey");
    expect(body).toContain("isSupported");
  });

  it("returns 304 on If-None-Match match", async () => {
    ctx = await createTestContext();
    const first = await request(ctx.app, "GET", "/auth/static/passkey.js", {
      headers: { origin: ORIGIN },
    });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await request(ctx.app, "GET", "/auth/static/passkey.js", {
      headers: { origin: ORIGIN, "if-none-match": etag ?? "" },
    });
    expect(second.status).toBe(304);
    const body = await second.text();
    expect(body).toBe("");
  });
});
