import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
const probe = vi.hoisted(() => ({
  enabled: false,
  retained: undefined as (() => Promise<unknown>) | undefined,
  entered: (): void => undefined,
  gate: Promise.resolve(),
}));
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  return {
    ...actual,
    betterAuth: ((options: Parameters<typeof actual.betterAuth>[0]) =>
      actual.betterAuth<import("better-auth").BetterAuthOptions>({
        ...options,
        databaseHooks: {
          ...options.databaseHooks,
          session: {
            create: {
              after: (session, context) => {
                if (!probe.enabled || !context) return Promise.resolve();
                const dispatch = AsyncLocalStorage.snapshot();
                const update = (name: string) =>
                  context.context.adapter.update({
                    model: "user",
                    where: [{ field: "id", value: session.userId }],
                    update: { name },
                  });
                probe.retained = () => dispatch(() => update("Escaped"));
                void update("Owned").catch(() => undefined);
                return Promise.resolve();
              },
            },
          },
        },
      })) as typeof actual.betterAuth,
  };
});
vi.mock("better-auth/adapters/drizzle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("better-auth/adapters/drizzle")>();
  return {
    ...actual,
    drizzleAdapter: ((...args: Parameters<typeof actual.drizzleAdapter>) => {
      const factory = actual.drizzleAdapter(...args);
      return (options: Parameters<typeof factory>[0]) => {
        const adapter = factory(options);
        const update = adapter.update.bind(adapter);
        adapter.update = async (input) => {
          if (probe.enabled && input.model === "user") {
            probe.entered();
            await probe.gate;
          }
          return update(input);
        };
        return adapter;
      };
    }) as typeof actual.drizzleAdapter,
  };
});
let ctx: TestContext | undefined;
afterEach(async () => {
  probe.enabled = false;
  await ctx?.cleanup();
});
it("drains an unawaited configured-handler adapter call and rejects its retained scope after finalization", async () => {
  ctx = await createTestContext();
  const body = {
    email: "owner@example.test",
    password: "correct horse battery",
  };
  expect(
    (await request(ctx.app, "POST", "/owner", { key: ctx.operatorKey, body }))
      .status,
  ).toBe(201);
  let release!: () => void;
  probe.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    probe.entered = resolve;
  });
  probe.enabled = true;
  let answered = false;
  const pending = request(ctx.app, "POST", "/auth/sign-in/email", {
    body,
    headers: { origin: "http://localhost:0" },
  }).then((response) => {
    answered = true;
    return response;
  });
  await entered;
  expect(answered).toBe(false);
  release();
  const accepted = await pending;
  expect(accepted.status).toBe(200);
  const db = ctx.storage as typeof ctx.storage & {
    __sqliteAll(sql: string): Promise<unknown[]>;
  };
  expect(await db.__sqliteAll("SELECT name FROM auth_user")).toEqual([
    { name: "Owned" },
  ]);
  await expect(probe.retained!()).rejects.toThrow("closed");
  expect(await db.__sqliteAll("SELECT name FROM auth_user")).toEqual([
    { name: "Owned" },
  ]);
  probe.enabled = false;
  const cookie = accepted.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(
    (
      await request(ctx.app, "POST", "/auth/update-user", {
        body: { name: "Fresh scope" },
        headers: { cookie, origin: "http://localhost:0" },
      })
    ).status,
  ).toBe(200);
  expect(await db.__sqliteAll("SELECT name FROM auth_user")).toEqual([
    { name: "Fresh scope" },
  ]);
});
