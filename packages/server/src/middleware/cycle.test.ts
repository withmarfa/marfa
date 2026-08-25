/**
 * Tests for `cycleMiddleware`.
 *
 * Exercises every resolution path: header pair (integration continuing a
 * chain), api-key fallback (integration chain head — runtime credential
 * and OAuth), and the human sentinel.
 *
 * These tests stand up a minimal Hono app with the same mounting order
 * as `app.ts` so the real middleware composition is exercised.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  cycleMiddleware,
  CYCLE_HEADERS as SERVER_CYCLE_HEADERS,
} from "./cycle.js";
import { CYCLE_HEADERS as KIT_CYCLE_HEADERS } from "@withmarfa/runtime-sdk";
import { cycleRequestContext } from "../cycle-context.js";
import type { AppEnv } from "./auth.js";
import type { ApiKey } from "@withmarfa/shared";

function buildApp(opts?: { apiKey?: ApiKey | undefined }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Stub auth: shove the supplied apiKey onto c.var.apiKey so the
  // cycle middleware's fallback path has something to read.
  app.use("*", async (c, next) => {
    c.set("apiKey", opts?.apiKey);
    await next();
  });
  app.use("*", cycleMiddleware());
  app.get("/echo", (c) => c.json({ cycle: c.var.cycle }));
  // Read the ALS-stored value from inside the handler so tests can
  // assert that `c.var.cycle` and `cycleRequestContext.getStore()`
  // resolve to the same shape (the middleware writes both in lockstep).
  app.get("/echo-both", (c) => {
    const als = cycleRequestContext.getStore() ?? null;
    return c.json({ varCycle: c.var.cycle, alsCycle: als });
  });
  return app;
}

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key_test",
    label: "test",
    source: "test",
    role: "admin",
    default_tier: "library",
    is_platform: false,
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...overrides,
  };
}

describe("cycleMiddleware", () => {
  describe("header path — integration continuing a chain", () => {
    it("uses the X-Marfa-Cycle-Origin / X-Marfa-Cycle-Hop pair when both present", async () => {
      const app = buildApp();
      const res = await app.request("/echo", {
        headers: {
          "x-marfa-cycle-origin": "conn-A",
          "x-marfa-cycle-hop": "3",
        },
      });
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: "conn-A",
        hopCount: 3,
      });
    });

    it("treats an empty origin string as null (chain head, headers spuriously sent)", async () => {
      const app = buildApp();
      const res = await app.request("/echo", {
        headers: {
          "x-marfa-cycle-origin": "",
          "x-marfa-cycle-hop": "0",
        },
      });
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: null,
        hopCount: 0,
      });
    });

    it("falls back to api-key shape when only one header is present", async () => {
      const app = buildApp({
        apiKey: apiKey({ connection_id: "conn-fallback" }),
      });
      // Only origin, no hop — middleware ignores the partial pair.
      const res = await app.request("/echo", {
        headers: { "x-marfa-cycle-origin": "conn-X" },
      });
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: "conn-fallback",
        hopCount: 0,
      });
    });

    it("falls back to api-key shape when X-Marfa-Cycle-Hop is malformed", async () => {
      const app = buildApp({
        apiKey: apiKey({ connection_id: "conn-fallback" }),
      });
      const res = await app.request("/echo", {
        headers: {
          "x-marfa-cycle-origin": "conn-X",
          "x-marfa-cycle-hop": "not-a-number",
        },
      });
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: "conn-fallback",
        hopCount: 0,
      });
    });

    it("falls back when X-Marfa-Cycle-Hop is negative", async () => {
      const app = buildApp({ apiKey: apiKey() });
      const res = await app.request("/echo", {
        headers: {
          "x-marfa-cycle-origin": "conn-X",
          "x-marfa-cycle-hop": "-1",
        },
      });
      const body = (await res.json()) as { cycle: unknown };
      // `apiKey()` has no connection binding → human sentinel fallback.
      expect(body.cycle).toEqual({
        originatingConnectionId: null,
        hopCount: 0,
      });
    });
  });

  describe("api-key fallback — chain head", () => {
    it("derives origin from `connection_id` on a runtime credential", async () => {
      const app = buildApp({
        apiKey: apiKey({
          is_runtime_credential: true,
          connection_id: "conn-runtime",
        }),
      });
      const res = await app.request("/echo");
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: "conn-runtime",
        hopCount: 0,
      });
    });

    it("derives origin from the `oauth:<id>` source prefix on an OAuth synthetic key", async () => {
      const app = buildApp({
        apiKey: apiKey({ source: "oauth:conn-oauth" }),
      });
      const res = await app.request("/echo");
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: "conn-oauth",
        hopCount: 0,
      });
    });

    it("does not derive origin from arbitrary `<prefix>:<id>` shapes", async () => {
      // Only `oauth:` is meaningful for cycle attribution today.
      // `test-admin-xyz`, `marfa/oauth/authorize`, etc. all stamp to null.
      const app = buildApp({
        apiKey: apiKey({ source: "test-admin-abc123" }),
      });
      const res = await app.request("/echo");
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: null,
        hopCount: 0,
      });
    });
  });

  describe("human sentinel — fallback of last resort", () => {
    it("yields { null, 0 } for a space-less admin api key with no connection binding", async () => {
      const app = buildApp({ apiKey: apiKey() });
      const res = await app.request("/echo");
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: null,
        hopCount: 0,
      });
    });

    it("yields { null, 0 } when no api key is set (anonymous request)", async () => {
      const app = buildApp({ apiKey: undefined });
      const res = await app.request("/echo");
      const body = (await res.json()) as { cycle: unknown };
      expect(body.cycle).toEqual({
        originatingConnectionId: null,
        hopCount: 0,
      });
    });
  });

  describe("cycleRequestContext — ALS lockstep", () => {
    it("writes the resolved cycle to BOTH c.var.cycle AND cycleRequestContext", async () => {
      const app = buildApp({
        apiKey: apiKey({
          is_runtime_credential: true,
          connection_id: "conn-lockstep",
        }),
      });
      const res = await app.request("/echo-both");
      const body = (await res.json()) as {
        varCycle: unknown;
        alsCycle: unknown;
      };
      const expected = {
        originatingConnectionId: "conn-lockstep",
        hopCount: 0,
      };
      expect(body.varCycle).toEqual(expected);
      expect(body.alsCycle).toEqual(expected);
    });

    it("the ALS reflects header-resolved cycle, not just the fallback shape", async () => {
      const app = buildApp();
      const res = await app.request("/echo-both", {
        headers: {
          "x-marfa-cycle-origin": "conn-hdr",
          "x-marfa-cycle-hop": "4",
        },
      });
      const body = (await res.json()) as {
        varCycle: unknown;
        alsCycle: unknown;
      };
      const expected = {
        originatingConnectionId: "conn-hdr",
        hopCount: 4,
      };
      expect(body.varCycle).toEqual(expected);
      expect(body.alsCycle).toEqual(expected);
    });

    it("the ALS does not leak across requests", async () => {
      // Two independent requests on the same Hono app instance must
      // each see their own resolved cycle; the AsyncLocalStorage's
      // run() scope is per-request.
      const app = buildApp();
      const [r1, r2] = await Promise.all([
        app.request("/echo-both", {
          headers: {
            "x-marfa-cycle-origin": "conn-one",
            "x-marfa-cycle-hop": "1",
          },
        }),
        app.request("/echo-both", {
          headers: {
            "x-marfa-cycle-origin": "conn-two",
            "x-marfa-cycle-hop": "2",
          },
        }),
      ]);
      const b1 = (await r1.json()) as { alsCycle: unknown };
      const b2 = (await r2.json()) as { alsCycle: unknown };
      expect(b1.alsCycle).toEqual({
        originatingConnectionId: "conn-one",
        hopCount: 1,
      });
      expect(b2.alsCycle).toEqual({
        originatingConnectionId: "conn-two",
        hopCount: 2,
      });
    });
  });
});

describe("the header names the kit stamps and this middleware reads", () => {
  /**
   * The crossing test. Both ends held their own copy of these names and
   * both docblocks claimed to be the one place they were kept; the server
   * additionally read a third, lowercase pair that the constant it exported
   * for the kit did not feed. A rename therefore needed three edits, and
   * nothing failed if you made two.
   *
   * Asserting the constants match each other would be circular now they
   * share a declaration. What this asserts is the thing that actually has
   * to hold: a request carrying what the kit stamps resolves here.
   */
  it("a request stamped by the kit's client resolves to the parent chain", async () => {
    const app = new Hono();
    app.use("*", cycleMiddleware());
    app.get("/echo", (c) => c.json({ cycle: cycleRequestContext.getStore() }));

    // Built the way ConnectionClient.request builds them, keyed off the
    // kit's own exported constant rather than a literal repeated here.
    const stamped: Record<string, string> = {};
    stamped[KIT_CYCLE_HEADERS.ORIGIN] = "conn-parent";
    stamped[KIT_CYCLE_HEADERS.HOP] = "3";

    const res = await app.request("/echo", { headers: stamped });

    expect(await res.json()).toEqual({
      cycle: { originatingConnectionId: "conn-parent", hopCount: 3 },
    });
  });

  it("both ends resolve to one object, so a second copy cannot creep back", () => {
    // Guards the single declaration, not the values. It deliberately does
    // not catch a rename: both ends derive from the same constant, so a
    // rename moves them together and this stays true. What catches an
    // unintended rename is the hardcoded header literals in the tests
    // above, which is the right division — this asserts the wiring, those
    // assert the names.
    expect(KIT_CYCLE_HEADERS).toBe(SERVER_CYCLE_HEADERS);
  });
});
