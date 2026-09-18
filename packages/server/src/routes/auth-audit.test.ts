import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request, waitForAudit } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Every auth-side wrapper writes a stable-shape audit row. Tests cover:
 *   - sign-up success → `auth.sign_up`
 *   - sign-in success → `auth.sign_in.success`
 *   - sign-in failure → `auth.sign_in.failed`
 *   - forgot-password (always) → `auth.password_reset.requested`
 *   - reset-password success → `auth.password_reset.completed`
 *
 * Verify-email success is audited too but its full token round-trip
 * is exercised in `email-verification.test.ts`; the audit shape there
 * is implicit.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function postForm(
  c: TestContext,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return c.app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

describe("auth audit-row hardening", () => {
  it("sign-up success writes an `auth.sign_up` audit row", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postForm(ctx, "/auth/sign-up", {
      email: "alice@example.com",
      name: "Alice",
      username: "alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);

    // Poll briefly until the fire-and-forget audit row lands.
    const ctxRef = ctx;
    const rows = await waitForAudit(
      () => ctxRef.storage.audit.list({ action: "auth.sign_up" }),
      (r) => r.data.length >= 1,
    );
    expect(rows.data).toHaveLength(1);
    const row = rows.data[0];
    expect(row?.resource_type).toBe("auth_user");
    expect(row?.resource_id).toBe("alice@example.com");
    expect(row?.details).toMatchObject({ email: "alice@example.com" });
  });

  it("sign-in success writes an `auth.sign_in.success` audit row", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // Direct better-auth sign-up to skip the wrapper's verify-email
    // redirect (which would 302 us elsewhere).
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "bob@example.com",
        password: "correct horse",
        name: "Bob",
      },
      headers: { origin: ORIGIN },
    });

    const res = await postForm(ctx, "/auth/sign-in", {
      mode: "password",
      email: "bob@example.com",
      password: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    // Poll until the fire-and-forget audit row lands.
    const ctxRef = ctx;
    const rows = await waitForAudit(
      () => ctxRef.storage.audit.list({ action: "auth.sign_in.success" }),
      (r) => r.data.some((d) => d.resource_id === "bob@example.com"),
    );
    expect(rows.data.length).toBeGreaterThanOrEqual(1);
    const row = rows.data.find((r) => r.resource_id === "bob@example.com");
    expect(row).toBeTruthy();
    expect(row?.details).toMatchObject({
      email: "bob@example.com",
      method: "password",
    });
  });

  it("sign-in failure writes an `auth.sign_in.failed` audit row with reason", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postForm(ctx, "/auth/sign-in", {
      mode: "password",
      email: "ghost@example.com",
      password: "wrong",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_credentials");
    const ctxRef = ctx;
    const rows = await waitForAudit(
      () => ctxRef.storage.audit.list({ action: "auth.sign_in.failed" }),
      (r) => r.data.some((d) => d.resource_id === "ghost@example.com"),
    );
    expect(rows.data.length).toBeGreaterThanOrEqual(1);
    const row = rows.data.find((r) => r.resource_id === "ghost@example.com");
    expect(row).toBeTruthy();
    expect(row?.details).toMatchObject({
      email: "ghost@example.com",
      method: "password",
      reason: "invalid_credentials",
    });
  });

  it("forgot-password writes `auth.password_reset.requested` regardless of upstream outcome", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, "/auth/forgot-password", {
      email: "ghost@example.com",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    const ctxRef = ctx;
    const rows = await waitForAudit(
      () =>
        ctxRef.storage.audit.list({ action: "auth.password_reset.requested" }),
      (r) => r.data.some((d) => d.resource_id === "ghost@example.com"),
    );
    expect(rows.data.length).toBeGreaterThanOrEqual(1);
    const row = rows.data.find((r) => r.resource_id === "ghost@example.com");
    expect(row).toBeTruthy();
    expect(row?.details).toMatchObject({ email: "ghost@example.com" });
  });

  it("reset-password success writes `auth.password_reset.completed`", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "carol@example.com",
        password: "old correct horse",
        name: "Carol",
      },
      headers: { origin: ORIGIN },
    });
    await postForm(ctx, "/auth/forgot-password", {
      email: "carol@example.com",
      return_to: "/",
    });
    // Read the verification row that better-auth wrote.
    const verRows = (await (
      ctx.storage as unknown as {
        __sqliteAll: (q: string) => Promise<unknown[]>;
      }
    ).__sqliteAll(
      `SELECT identifier FROM auth_verification WHERE identifier LIKE 'reset-password:%' ORDER BY created_at DESC LIMIT 1`,
    )) as { identifier: string }[];
    const token = verRows[0]?.identifier.slice("reset-password:".length);
    expect(token).toBeTruthy();

    const reset = await postForm(ctx, "/auth/reset-password", {
      token: token ?? "",
      password: "new correct horse",
      password_confirm: "new correct horse",
      return_to: "/",
    });
    expect(reset.status).toBe(200);
    const ctxRef = ctx;
    const rows = await waitForAudit(
      () =>
        ctxRef.storage.audit.list({ action: "auth.password_reset.completed" }),
      (r) => r.data.length >= 1,
    );
    expect(rows.data.length).toBeGreaterThanOrEqual(1);
  });
});
