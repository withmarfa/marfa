import { afterEach, expect, it, vi } from "vitest";
import census from "./credential-census.json" with { type: "json" };
import {
  FENCED_PLUGIN_ENDPOINTS,
  SERVED_LIBRARY_PATHS,
} from "../routes/auth-fence.js";
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
  }
  // The plugin's own fenced list and the census agree that none of it is
  // served.
  for (const path of FENCED_PLUGIN_ENDPOINTS)
    expect(SERVED_LIBRARY_PATHS.has(path), path).toBe(false);
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
it("serves over the wire only the library routes Marfa uses", () => {
  // The served set is a decision, so it is written twice: reclassifying a
  // census entry, or a library upgrade that adds a served route, changes it
  // here as well.
  expect([...SERVED_LIBRARY_PATHS].sort()).toEqual([
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/change-password",
    "/device",
    "/device/code",
    "/error",
    "/get-session",
    "/jwks",
    "/oauth2/authorize",
    "/oauth2/end-session",
    "/oauth2/end-session/confirm",
    "/oauth2/introspect",
    "/oauth2/register",
    "/oauth2/revoke",
    "/oauth2/token",
    "/oauth2/userinfo",
    "/revoke-other-sessions",
    "/revoke-sessions",
    "/sign-in/email",
    "/sign-out",
  ]);
});
