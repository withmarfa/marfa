import { afterEach, expect, it, vi } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
const probe = vi.hoisted(() => ({
  hashes: 0,
  verifies: 0,
  availableWriter: () => Promise.resolve(),
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
              return crypto.verifyPassword(input);
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
});
it("finishes real password hashing and verification before opening the credential persistence writer", async () => {
  ctx = await createTestContext();
  let writes = 0;
  probe.availableWriter = () =>
    ctx!.storage.settings.set("password.preparation", String(++writes));
  const body = {
    email: "owner@example.test",
    password: "correct horse battery",
  };
  expect(
    (await request(ctx.app, "POST", "/owner", { key: ctx.operatorKey, body }))
      .status,
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
