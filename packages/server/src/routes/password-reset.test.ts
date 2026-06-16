import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  readLatestResetToken,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Full forgot-password + reset round-trip.
 * Sign up, request reset, read the token from auth_verification (no
 * email transport in tests; the hook just logs), submit the reset,
 * sign in with the new password.
 *
 * Also exercises better-auth's `revokeSessionsOnPasswordReset: true`
 * — pre-existing sessions for the user are dropped on successful reset.
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

describe("full forgot → reset → sign-in flow", () => {
  it("user can reset their password and sign in with the new one", async () => {
    ctx = await createTestContext({ authAllowSignup: true });

    // 1. Sign up
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "alice@example.com",
        password: "old correct horse",
        name: "Alice",
      },
      headers: { origin: ORIGIN },
    });

    // 2. Request password reset
    const requested = await postForm(ctx, "/auth/forgot-password", {
      email: "alice@example.com",
      return_to: "/",
    });
    expect(requested.status).toBe(302);
    expect(requested.headers.get("location")).toContain("sent=1");

    // 3. Read the reset token from auth_verification
    const token = await readLatestResetToken(ctx.storage);
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");

    // 4. Submit the new password via POST /auth/reset-password
    const reset = await postForm(ctx, "/auth/reset-password", {
      token: token ?? "",
      password: "new correct horse",
      password_confirm: "new correct horse",
      return_to: "/",
    });
    expect(reset.status).toBe(200);
    const html = await reset.text();
    expect(html).toContain("Password updated");
    expect(html).toContain('role="status"');

    // 5. Sign in with the new password
    const signIn = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: {
        email: "alice@example.com",
        password: "new correct horse",
      },
      headers: { origin: ORIGIN },
    });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie")).toBeTruthy();

    // 6. Old password no longer works
    const signInOld = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: {
        email: "alice@example.com",
        password: "old correct horse",
      },
      headers: { origin: ORIGIN },
    });
    expect(signInOld.status).toBeGreaterThanOrEqual(400);
  });

  it("expired / single-use token is rejected on the second submit", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "bob@example.com",
        password: "old correct horse",
        name: "Bob",
      },
      headers: { origin: ORIGIN },
    });
    await postForm(ctx, "/auth/forgot-password", {
      email: "bob@example.com",
      return_to: "/",
    });
    const token = await readLatestResetToken(ctx.storage);
    expect(token).toBeTruthy();

    // First submit succeeds
    const first = await postForm(ctx, "/auth/reset-password", {
      token: token ?? "",
      password: "new correct horse",
      password_confirm: "new correct horse",
      return_to: "/",
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Password updated");

    // Second submit with same token — better-auth deletes the
    // verification row on consume, so the second attempt finds nothing.
    const second = await postForm(ctx, "/auth/reset-password", {
      token: token ?? "",
      password: "another correct horse",
      password_confirm: "another correct horse",
      return_to: "/",
    });
    expect(second.status).toBe(200);
    const html = await second.text();
    expect(html).toContain("That link didn't work");
    expect(html).toContain('href="/auth/forgot-password"');
  });

  it("revokeSessionsOnPasswordReset terminates pre-existing sessions", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "carol@example.com",
        password: "old correct horse",
        name: "Carol",
      },
      headers: { origin: ORIGIN },
    });

    // Establish a session — sign in once and capture the cookie.
    const signIn = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: {
        email: "carol@example.com",
        password: "old correct horse",
      },
      headers: { origin: ORIGIN },
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    // Sanity — the cookie validates a `get-session` request right now.
    const liveSession = await request(ctx.app, "GET", "/auth/get-session", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    expect(liveSession.status).toBe(200);
    const liveBody = (await liveSession.json()) as {
      user?: { email?: string };
    } | null;
    expect(liveBody?.user?.email).toBe("carol@example.com");

    // Reset the password via the same flow.
    await postForm(ctx, "/auth/forgot-password", {
      email: "carol@example.com",
      return_to: "/",
    });
    const token = await readLatestResetToken(ctx.storage);
    const reset = await postForm(ctx, "/auth/reset-password", {
      token: token ?? "",
      password: "new correct horse",
      password_confirm: "new correct horse",
      return_to: "/",
    });
    expect(reset.status).toBe(200);

    // The pre-reset session cookie should no longer authenticate.
    const dead = await request(ctx.app, "GET", "/auth/get-session", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    // better-auth returns 200 with a null body on an invalid session.
    const deadBody = (await dead.json()) as {
      user?: { email?: string };
    } | null;
    expect(deadBody?.user).toBeUndefined();
  });
});
