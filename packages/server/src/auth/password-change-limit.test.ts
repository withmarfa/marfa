/**
 * The owner's current password, checked by a password change, counts against
 * the sign-in windows, and each refusal is in the audit log.
 */
import { afterEach, expect, it, vi } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import { SIGN_IN_ADDRESS_LIMIT } from "./sign-in-throttle.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function signIn(c: TestContext): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-in/email", {
    body: { email: c.owner.email, password: c.owner.password },
    headers: { origin: ORIGIN },
  });
}

function cookieOf(response: Response): string {
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  );
  if (!match?.[1]) throw new Error("sign-in set no session cookie");
  return match[1];
}

function changeOverApi(c: TestContext, cookie: string, current: string) {
  return request(c.app, "POST", "/auth/change-password", {
    body: { currentPassword: current, newPassword: "a new password here" },
    headers: { cookie, origin: ORIGIN },
  });
}

async function refusals(c: TestContext): Promise<string[]> {
  const page = await c.storage.audit.list({
    action: "owner.password.change_failed",
    limit: 100,
  });
  return page.data.map(
    (entry) => (entry.details as { reason?: string }).reason ?? "",
  );
}

it("refuses guesses once the sign-in window is spent, before judging the password", async () => {
  ctx = await createTestContext({});
  const signedIn = await signIn(ctx);
  expect(signedIn.status).toBe(200);
  const cookie = cookieOf(signedIn);
  // Start from an empty window, whatever signing in has spent.
  await ctx.storage.rateLimits.clearSignIn(ctx.owner.email);

  for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i++) {
    const wrong = await changeOverApi(ctx, cookie, `guess ${String(i)}`);
    expect(wrong.status, `guess ${String(i)}`).toBe(401);
  }
  expect(await refusals(ctx)).toEqual(
    Array(SIGN_IN_ADDRESS_LIMIT).fill("invalid_credentials"),
  );

  const refused = await changeOverApi(ctx, cookie, ctx.owner.password);
  expect(refused.status).toBe(429);
  expect(refused.headers.get("x-error-code")).toBe("rate_limited");
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await refusals(ctx)).slice(0, 1)).toEqual(["too_many_attempts"]);
  // The password did not change, and sign-in is held by the same window.
  expect((await signIn(ctx)).status).toBe(429);
});

it("clears the window when the right password changes it", async () => {
  ctx = await createTestContext({});
  const signedIn = await signIn(ctx);
  const cookie = cookieOf(signedIn);
  await ctx.storage.rateLimits.clearSignIn(ctx.owner.email);
  for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT - 1; i++)
    expect((await changeOverApi(ctx, cookie, "wrong")).status).toBe(401);
  const changed = await changeOverApi(ctx, cookie, ctx.owner.password);
  expect(changed.status).toBe(200);
  for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i++)
    expect((await changeOverApi(ctx, cookie, "wrong")).status).toBe(401);
});
