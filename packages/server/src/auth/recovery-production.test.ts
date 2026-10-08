import { expect, it, vi } from "vitest";
import { createClaimTestApp } from "./claim-test-app.js";
import { claimOwner, recoverOwnerPassword } from "./instance-claim.js";
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  return {
    ...actual,
    betterAuth: ((options: Parameters<typeof actual.betterAuth>[0]) =>
      actual.betterAuth<import("better-auth").BetterAuthOptions>({
        ...options,
        rateLimit: { ...options.rateLimit, enabled: true },
      })) as typeof actual.betterAuth,
  };
});
it("a locally recovered owner can sign in immediately with production rate limiting enabled", async () => {
  const ctx = await createClaimTestApp();
  try {
    const email = "owner@example.com",
      password = "correct horse battery";
    await claimOwner(ctx.storage, ctx.auth, {
      email,
      password,
      proof: { kind: "code", code: ctx.setupCode, address: "127.0.0.1" },
    });
    const signIn = (candidate: string) =>
      ctx.auth.handler(
        new Request("http://localhost:8600/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:8600",
          },
          body: JSON.stringify({ email, password: candidate }),
        }),
        "127.0.0.1",
      );
    for (let i = 0; i < 10; i++)
      expect((await signIn("incorrect password")).status).toBe(401);
    expect((await signIn(password)).status).toBe(429);
    await recoverOwnerPassword(ctx.storage, ctx.auth, {
      password: "replacement password",
    });
    expect((await signIn("replacement password")).status).toBe(200);
  } finally {
    await ctx.cleanup();
  }
});
