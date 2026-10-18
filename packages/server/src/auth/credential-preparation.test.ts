import { afterEach, expect, it, vi } from "vitest";
import { request } from "../test-utils.js";
import { createClaimTestApp } from "./claim-test-app.js";
type TestContext = Awaited<ReturnType<typeof createClaimTestApp>>;
const probe = vi.hoisted(() => ({
  hashes: 0,
  verifies: 0,
  availableWriter: () => Promise.resolve(),
  afterVerification: () => Promise.resolve(),
}));
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  const crypto = await import("better-auth/crypto");
  const { transactionControl } =
    await import("../storage/sqlite/transaction-control.js");
  return {
    ...actual,
    betterAuth: ((options: Parameters<typeof actual.betterAuth>[0]) =>
      actual.betterAuth<import("better-auth").BetterAuthOptions>({
        ...options,
        emailAndPassword: {
          ...options.emailAndPassword,
          enabled: true,
          password: {
            hash: async (password) => {
              expect(transactionControl.getStore()).toBeUndefined();
              await probe.availableWriter();
              probe.hashes++;
              return crypto.hashPassword(password);
            },
            verify: async (input) => {
              expect(transactionControl.getStore()).toBeUndefined();
              await probe.availableWriter();
              probe.verifies++;
              const verify = options.emailAndPassword?.password?.verify;
              if (!verify)
                throw new Error("The configured password verifier is required");
              const result = await verify(input);
              await probe.afterVerification();
              return result;
            },
          },
        },
      })) as typeof actual.betterAuth,
  };
});
let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
  probe.availableWriter = () => Promise.resolve();
  probe.afterVerification = () => Promise.resolve();
});
it("finishes real password hashing and verification before opening the credential persistence writer", async () => {
  ctx = await createClaimTestApp("http://localhost:0");
  let writes = 0;
  probe.availableWriter = () =>
    ctx!.storage.settings.set("password.preparation", String(++writes));
  const body = {
    email: "owner@example.test",
    password: "correct horse battery",
  };
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(201);
  const signed = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body,
    headers: { origin: "http://localhost:0" },
  });
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(
    (
      await request(ctx.app, "POST", "/auth/change-password", {
        body: {
          currentPassword: body.password,
          newPassword: "a different correct password",
          revokeOtherSessions: true,
        },
        headers: { cookie, origin: "http://localhost:0" },
      })
    ).status,
  ).toBe(200);
  expect(probe.hashes).toBe(2);
  expect(probe.verifies).toBe(2);
  expect(writes).toBe(4);
  expect(await ctx.storage.settings.get("password.preparation")).toBe("4");
});

it("refuses an old-email password attempt when the owner changes email after verification", async () => {
  ctx = await createClaimTestApp("http://localhost:0");
  const body = {
    email: "owner@example.test",
    password: "correct horse battery",
  };
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(201);
  const signed = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body: { ...body, email: "OWNER@example.test" },
    headers: { origin: "http://localhost:0" },
  });
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  probe.afterVerification = async () => {
    arrive();
    await gate;
  };
  const pending = request(ctx.app, "POST", "/auth/sign-in/email", {
    body,
    headers: { origin: "http://localhost:0" },
  });
  try {
    await arrived;
    expect(
      (
        await request(ctx.app, "PATCH", "/owner", {
          body: { email: "new@example.test" },
          headers: { origin: "http://localhost:0", cookie },
        })
      ).status,
    ).toBe(200);
  } finally {
    release();
  }
  const refused = await pending;
  expect(refused.ok).toBe(false);
  expect(refused.headers.getSetCookie()).toHaveLength(0);
  probe.afterVerification = () => Promise.resolve();
  expect(
    (
      await request(ctx.app, "POST", "/auth/sign-in/email", {
        body: { ...body, email: "new@example.test" },
        headers: { origin: "http://localhost:0" },
      })
    ).status,
  ).toBe(200);
});
