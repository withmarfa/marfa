import { afterEach, expect, it, vi } from "vitest";
import census from "./credential-census.json" with { type: "json" };
import { FENCED_PLUGIN_ENDPOINTS } from "../routes/oauth-plugin-fence.js";
import { createTestContext, type TestContext } from "../test-utils.js";
const observed = vi.hoisted(() => ({ methods: [] as string[] }));
vi.mock("better-auth/adapters/drizzle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("better-auth/adapters/drizzle")>();
  return {
    ...actual,
    drizzleAdapter: ((...args: Parameters<typeof actual.drizzleAdapter>) => {
      const factory = actual.drizzleAdapter(...args);
      return (options: Parameters<typeof factory>[0]) => {
        const adapter = factory(options);
        observed.methods = Object.entries(adapter)
          .filter(([, value]) => typeof value === "function")
          .map(([name]) => name)
          .sort();
        return adapter;
      };
    }) as typeof actual.drizzleAdapter,
  };
});
let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
});
it("classifies every endpoint and adapter method in the configured provider", async () => {
  ctx = await createTestContext();
  const endpoints = ctx.auth.api as Record<string, { path?: string }>;
  expect(Object.keys(endpoints).sort()).toEqual(Object.keys(census).sort());
  for (const [name, entry] of Object.entries(census)) {
    expect(endpoints[name]?.path ?? null, name).toBe(entry.path);
    if (["fenced", "internal-consent-device"].includes(entry.boundary))
      expect(FENCED_PLUGIN_ENDPOINTS, name).toContain(entry.path);
  }
  expect(observed.methods).toEqual(
    [
      "count",
      "create",
      "delete",
      "deleteMany",
      "findMany",
      "findOne",
      "incrementOne",
      "consumeOne",
      "transaction",
      "update",
      "updateMany",
    ].sort(),
  );
});
