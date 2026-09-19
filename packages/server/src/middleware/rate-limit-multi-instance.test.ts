import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import { rateLimitMiddleware } from "./rate-limit.js";
import type { AppEnv } from "./auth.js";
import { createErrorHandler } from "./error-handler.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * The cap is one budget, not one per middleware.
 *
 * Two middleware instances bound to the same `Storage` handle. Neither
 * holds a count of its own — every request goes to the row — so the
 * property is that the same `(family, window_key)` row is seen by both,
 * and a caller cannot buy a second budget by reaching a second instance.
 *
 * Two handles rather than two processes, because the row is what the
 * property is about and a second process would prove the same thing at the
 * cost of a subprocess.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/**
 * Spin up two Hono mini-apps that each carry the rate-limit middleware
 * pointed at the same underlying `Storage`: two apps over one
 * `storage`, compressed into one process.
 *
 * Each app mounts the standard `createErrorHandler` so MarfaError
 * (thrown by the middleware on rate-limit) coerces to a 429 response,
 * matching production wiring.
 */
async function makeTwoInstances(opts: {
  defaultLimit: number;
}): Promise<{ appA: Hono<AppEnv>; appB: Hono<AppEnv> }> {
  ctx = await createTestContext();
  const storage = ctx.storage;

  const config = {
    defaultLimit: opts.defaultLimit,
    windowMs: 60_000,
    pathLimits: {},
    trustedProxyCidrs: [],
    storage,
  };
  const handler = (c: Context<AppEnv>) => c.text("ok");
  const errorHandler = createErrorHandler({ errorWebhookUrl: "" });

  const appA = new Hono<AppEnv>();
  appA.onError(errorHandler);
  appA.use("*", rateLimitMiddleware(config));
  appA.get("/probe", handler);

  const appB = new Hono<AppEnv>();
  appB.onError(errorHandler);
  appB.use("*", rateLimitMiddleware(config));
  appB.get("/probe", handler);

  return { appA, appB };
}

async function probe(app: Hono<AppEnv>): Promise<Response> {
  // The middleware identifier falls back to "anon" without an apiKey
  // or trusted-XFF source — both apps share that identifier, so they
  // also share the `(family, window_key) = ("rate", "anon:/probe")`
  // row. That's exactly what we want for the assertion.
  return await app.fetch(new Request("http://test/probe", { method: "GET" }));
}

describe("rate-limit middleware — one cap across instances", () => {
  it("two instances against one DB cannot collectively exceed the per-credential cap", async () => {
    // GET requests double the configured cap, so with defaultLimit=5
    // the effective cap is 10. Send 12 requests alternating across the
    // two app handles: 10 succeed, 2 are rate-limited.
    const { appA, appB } = await makeTwoInstances({ defaultLimit: 5 });

    const responses: Response[] = [];
    for (let i = 0; i < 12; i++) {
      responses.push(await probe(i % 2 === 0 ? appA : appB));
    }
    const okCount = responses.filter((r) => r.status === 200).length;
    const rateLimitedCount = responses.filter((r) => r.status === 429).length;

    expect(okCount).toBe(10);
    expect(rateLimitedCount).toBe(2);
  });

  it("once instance A exhausts the cap, instance B sees the same state immediately", async () => {
    const { appA, appB } = await makeTwoInstances({ defaultLimit: 5 });

    // Exhaust the GET cap (10) on instance A only.
    for (let i = 0; i < 10; i++) {
      const r = await probe(appA);
      expect(r.status).toBe(200);
    }
    // Instance B's very next request sees the shared counter at 10 →
    // increments to 11 → over the cap → 429.
    const r = await probe(appB);
    expect(r.status).toBe(429);
  });
});
