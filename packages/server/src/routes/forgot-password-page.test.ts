import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderForgotPasswordPage } from "./forgot-password-page.js";

/**
 * Forgot-password page renderer + handler smoke.
 * Token round-trip via the live email transport is exercised in
 * `password-reset.test.ts`; this file covers the renderer states + the
 * route-side throttle/soft-fail invariants.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderForgotPasswordPage", () => {
  it("links to the shared stylesheet and has no inline <style>", () => {
    const html = renderForgotPasswordPage({ state: "form" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("form state renders the email input + submit button", () => {
    const html = renderForgotPasswordPage({ state: "form" });
    expect(html).toContain(
      '<form method="POST" action="/auth/forgot-password"',
    );
    expect(html).toContain('name="email"');
    expect(html).toContain("Send reset link");
    expect(html).toContain('href="/auth/sign-in"');
  });

  it("sent state echoes the email in a soft-fail success banner", () => {
    const html = renderForgotPasswordPage({
      state: "sent",
      email: "alice@example.com",
    });
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain("alice@example.com");
    expect(html).toContain("If an account exists");
  });

  it("error state with rate_limited renders the friendly throttle message", () => {
    const html = renderForgotPasswordPage({
      state: "error",
      errorCode: "rate_limited",
    });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Too many reset requests");
  });

  it("error state with email_not_configured renders the operator-error message", () => {
    const html = renderForgotPasswordPage({
      state: "error",
      errorCode: "email_not_configured",
    });
    expect(html).toContain("isn&#39;t available on this server");
  });

  it("escapes the email + return_to to prevent template injection", () => {
    const html = renderForgotPasswordPage({
      state: "form",
      email: '"><script>x</script>',
      returnTo: '/foo"><script>y</script>',
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<script>y</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("GET /auth/forgot-password", () => {
  it("returns 200 + text/html with the form", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/forgot-password", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Reset your password");
    expect(html).toContain('action="/auth/forgot-password"');
  });

  it("renders the sent state when ?sent=1", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/forgot-password?sent=1&email=alice%40example.com",
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain("alice@example.com");
  });

  it("§3.18: returns Cache-Control: no-store + Pragma: no-cache", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/forgot-password", {
      headers: { origin: ORIGIN },
    });
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, private",
    );
    expect(res.headers.get("pragma")).toBe("no-cache");
  });
});

describe("POST /auth/forgot-password (form wrapper)", () => {
  async function postForm(
    c: TestContext,
    fields: Record<string, string>,
  ): Promise<Response> {
    return c.app.fetch(
      new Request(`${ORIGIN}/auth/forgot-password`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  }

  it("redirects with sent=1 on a valid email (soft-fail)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // Sign up so the address is real (the soft-fail invariant means it'd
    // 302 either way, but exercising the live address proves the
    // dispatch reaches better-auth's request-password-reset endpoint).
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "alice@example.com",
        password: "correct horse",
        name: "Alice",
      },
      headers: { origin: ORIGIN },
    });
    const res = await postForm(ctx, {
      email: "alice@example.com",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/forgot-password");
    expect(location).toContain("sent=1");
    expect(location).toContain("email=alice%40example.com");
  });

  it("redirects with sent=1 on an unknown email too (no enumeration)", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, {
      email: "ghost@example.com",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sent=1");
  });

  it("emits no ERROR log when the email doesn't exist", async () => {
    ctx = await createTestContext();
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      const res = await postForm(ctx, {
        email: "ghost@example.com",
        return_to: "/",
      });
      expect(res.status).toBe(302);
    } finally {
      process.stdout.write = original;
    }
    const errorLines = captured.filter(
      (line) =>
        line.includes('"level":"error"') &&
        /Reset Password.*User not found/.test(line),
    );
    expect(errorLines).toEqual([]);
  });

  it("redirects without sent=1 when the email is malformed", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, {
      email: "not-an-email",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/forgot-password");
    expect(location).not.toContain("sent=1");
  });

  it("returns rate_limited error after 3 attempts in the window", async () => {
    ctx = await createTestContext();
    const fields = {
      email: "rate-test@example.com",
      return_to: "/",
    };
    const r1 = await postForm(ctx, fields);
    const r2 = await postForm(ctx, fields);
    const r3 = await postForm(ctx, fields);
    expect(r1.headers.get("location")).toContain("sent=1");
    expect(r2.headers.get("location")).toContain("sent=1");
    expect(r3.headers.get("location")).toContain("sent=1");
    const r4 = await postForm(ctx, fields);
    expect(r4.status).toBe(302);
    expect(r4.headers.get("location")).toContain("error=rate_limited");
    expect(r4.headers.get("location")).not.toContain("sent=1");
  });

  it("rejects unsafe return_to values and threads / through the redirect", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, {
      email: "alice@example.com",
      return_to: "https://evil.com/",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("return_to=%2F");
    expect(location).not.toContain("evil.com");
  });
});
