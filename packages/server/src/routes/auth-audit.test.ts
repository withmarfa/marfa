import { describe, it, expect, afterEach } from "vitest";
import { createTestAccount, createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

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
    await createTestAccount(ctx, "bob@example.com", "correct horse", "Bob");

    const res = await postForm(ctx, "/auth/sign-in", {
      mode: "password",
      email: "bob@example.com",
      password: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    const ctxRef = ctx;
    const rows = await ctxRef.storage.audit.list({
      action: "auth.sign_in.success",
    });
    expect(rows.data.some((d) => d.resource_id === "bob@example.com")).toBe(
      true,
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
    const rows = await ctxRef.storage.audit.list({
      action: "auth.sign_in.failed",
    });
    expect(rows.data.some((d) => d.resource_id === "ghost@example.com")).toBe(
      true,
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
