import { afterEach, expect, it, vi } from "vitest";
import { createClaimTestApp } from "./claim-test-app.js";
import {
  claimOwner,
  changeOwnerPassword,
  recoverOwnerPassword,
} from "./instance-claim.js";

const gate = vi.hoisted(() => ({
  pause: undefined as undefined | (() => Promise<void>),
}));
vi.mock("better-auth", async (original) => {
  const actual = await original<typeof import("better-auth")>();
  return {
    ...actual,
    betterAuth: ((options: Parameters<typeof actual.betterAuth>[0]) => {
      const verify = options.emailAndPassword?.password?.verify;
      if (!verify)
        throw new Error("The configured password verifier is required");
      return actual.betterAuth<import("better-auth").BetterAuthOptions>({
        ...options,
        emailAndPassword: {
          ...options.emailAndPassword,
          enabled: true,
          password: {
            ...options.emailAndPassword?.password,
            verify: async (input) => {
              const result = await verify(input);
              if (gate.pause) await gate.pause();
              return result;
            },
          },
        },
      });
    }) as typeof actual.betterAuth,
  };
});
afterEach(() => {
  gate.pause = undefined;
});
const origin = "http://localhost:8600";
const details = {
  email: "owner@example.com",
  password: "correct horse battery",
};

it.each(["recovery", "change"] as const)(
  "refuses an old-password sign-in resumed after password %s",
  async (operation) => {
    const ctx = await createClaimTestApp();
    let resume: (() => void) | undefined;
    let signingIn: Promise<Response> | undefined;
    const signIn = (password: string, cookie?: string) =>
      ctx.app.request(`${origin}/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ email: details.email, password }),
      });
    try {
      await claimOwner(ctx.storage, ctx.auth, {
        ...details,
        proof: { kind: "local" },
      });
      const witness = await signIn(details.password);
      expect(witness.status).toBe(200);
      const cookie = witness.headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .join("; ");
      let verified!: () => void;
      const atVerify = new Promise<void>((resolve) => {
        verified = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      gate.pause = async () => {
        verified();
        await resumed;
      };
      signingIn = signIn(details.password, cookie);
      await atVerify;
      gate.pause = undefined;
      if (operation === "recovery") {
        await recoverOwnerPassword(ctx.storage, ctx.auth, {
          password: "replacement password",
        });
      } else {
        await changeOwnerPassword(
          ctx.storage,
          ctx.auth,
          new Headers({ cookie }),
          {
            currentPassword: details.password,
            password: "replacement password",
          },
        );
      }
      const survivors = operation === "recovery" ? 0 : 1;
      expect(
        await ctx.storage.__sqliteAll("SELECT id FROM auth_session"),
      ).toHaveLength(survivors);
      resume!();
      const response = await signingIn;
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(
        await ctx.storage.__sqliteAll("SELECT id FROM auth_session"),
      ).toHaveLength(survivors);
      expect((await signIn("replacement password")).status).toBe(200);
      expect(
        await ctx.storage.__sqliteAll("SELECT id FROM auth_session"),
      ).toHaveLength(survivors + 1);
    } finally {
      gate.pause = undefined;
      resume?.();
      await signingIn?.catch(() => undefined);
      await ctx.cleanup();
    }
  },
);

it("allows a verified sign-in when its incidental owner cookie ends before persistence", async () => {
  const ctx = await createClaimTestApp();
  let resume: (() => void) | undefined;
  let signingIn: Promise<Response> | undefined;
  const signIn = (cookie?: string) =>
    ctx.app.request(`${origin}/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(details),
    });
  try {
    await claimOwner(ctx.storage, ctx.auth, {
      ...details,
      proof: { kind: "local" },
    });
    const before = await signIn();
    expect(before.status).toBe(200);
    const cookie = before.headers
      .getSetCookie()
      .map((part) => part.split(";")[0])
      .join("; ");
    let verified!: () => void;
    const atVerify = new Promise<void>((resolve) => {
      verified = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    gate.pause = async () => {
      verified();
      await resumed;
    };
    signingIn = signIn(cookie);
    await atVerify;
    gate.pause = undefined;
    const ended = await ctx.app.request(`${origin}/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: "{}",
    });
    expect(ended.status).toBe(200);
    expect(
      await ctx.storage.__sqliteAll("SELECT id FROM auth_session"),
    ).toHaveLength(0);
    resume!();
    const response = await signingIn;
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    expect(
      await ctx.auth.getSession(new Headers({ cookie }), { readOnly: true }),
    ).toBeNull();
    expect(
      await ctx.storage.__sqliteAll("SELECT id FROM auth_session"),
    ).toHaveLength(1);
  } finally {
    gate.pause = undefined;
    resume?.();
    await signingIn?.catch(() => undefined);
    await ctx.cleanup();
  }
});
