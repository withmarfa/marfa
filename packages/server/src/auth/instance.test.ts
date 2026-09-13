/**
 * What Better Auth is told about client addresses.
 *
 * Better Auth runs a rate limiter of its own, separate from Marfa's, and
 * keys it on the address `getIP` resolves from the headers it has been
 * told to read. Resolve nothing and every caller in the world shares one
 * bucket, so three failed sign-ins from anyone lock out everyone.
 *
 * This asserts on the options object handed to `betterAuth` rather than
 * on a request, because a request cannot show it: `getIP` short-circuits
 * to `127.0.0.1` whenever `isTest()` or `isDevelopment()` holds, so every
 * caller resolves to the same address under a test runner whether the
 * mapping is right or wrong. The configuration is the only observable
 * that differs.
 */
import { describe, expect, it, vi } from "vitest";

const capturedOptions: Record<string, unknown>[] = [];

vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  return {
    ...actual,
    // Capture and stub rather than construct: the options are the whole
    // subject, and a real instance would want a database to build
    // against for no gain.
    betterAuth: (options: Record<string, unknown>) => {
      capturedOptions.push(options);
      return {
        handler: () => Promise.resolve(new Response(null, { status: 404 })),
        api: { getSession: () => Promise.resolve(null) },
        $context: Promise.resolve({}),
      };
    },
  };
});

const { createMarfaAuth } = await import("./instance.js");
type MarfaAuthOptions = Parameters<typeof createMarfaAuth>[0];

interface AdvancedOptions {
  ipAddress?: { ipAddressHeaders?: string[] };
  cookiePrefix?: string;
}

/** Build an instance and return the `advanced` block Better Auth was
 *  given. `overrides` carries only the field under test, so an absent
 *  `trustedProxyHeader` is the real unconfigured case rather than one
 *  spelled explicitly. */
function advancedFor(overrides: Partial<MarfaAuthOptions>): AdvancedOptions {
  const auth = createMarfaAuth({
    // Never queried: the adapter is built and handed to the stub.
    db: {},
    dialect: "sqlite",
    baseURL: "http://localhost:8600",
    allowSignup: false,
    ...overrides,
  });
  auth.stopOidcRetries();
  const options = capturedOptions[capturedOptions.length - 1];
  if (!options) throw new Error("betterAuth was never called");
  return options.advanced as AdvancedOptions;
}

describe("createMarfaAuth client address configuration", () => {
  it("reads the configured proxy header", () => {
    const advanced = advancedFor({ trustedProxyHeader: "x-real-ip" });
    expect(advanced.ipAddress?.ipAddressHeaders).toEqual(["x-real-ip"]);
  });

  it("carries whatever header is configured, not a fixed one", () => {
    const advanced = advancedFor({ trustedProxyHeader: "cf-connecting-ip" });
    expect(advanced.ipAddress?.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
  });

  it("leaves the default alone when no header is configured", () => {
    // Better Auth reads `x-forwarded-for` when told nothing, which is
    // what an ordinary reverse proxy sends. Emitting an empty or
    // defaulted `ipAddress` block here would take that away from every
    // self-hoster, so the absence of the key is the assertion.
    const advanced = advancedFor({});
    expect(advanced).not.toHaveProperty("ipAddress");
    // The rest of the block still has to arrive, or the assertion above
    // would also pass against an `advanced` that was never built.
    expect(advanced.cookiePrefix).toBe("marfa.auth");
  });

  it("treats an explicit null the way it treats an absent value", () => {
    // `app.ts` passes `config.trustedProxyHeader ?? null`, so null is the
    // shape an unconfigured deployment actually sends.
    const advanced = advancedFor({ trustedProxyHeader: null });
    expect(advanced).not.toHaveProperty("ipAddress");
  });
});
