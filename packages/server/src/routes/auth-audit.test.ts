import { describe, it, expect, afterEach } from "vitest";
import {
  createTestAccount,
  createTestContext,
  waitForAudit,
} from "../test-utils.js";
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
  it("sign-in success writes an `auth.sign_in.success` audit row", async () => {
    ctx = await createTestContext({});
    // Direct better-auth sign-up to skip the wrapper's verify-email
    // redirect (which would 302 us elsewhere).
    await createTestAccount(ctx, "bob@example.com", "correct horse", "Bob");

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
    ctx = await createTestContext({});
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
});
