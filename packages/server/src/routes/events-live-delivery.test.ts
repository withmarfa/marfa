/**
 * A subscription that fails is the stream failing, said to the client.
 *
 * For the client leaving, the pending read rejects with the abort after
 * cleanup has run, and that is the subscription ending. For anything else
 * the stream has to say so and close: a connection that stayed open after
 * its source stopped would look live to a client holding a cursor that no
 * longer moves.
 *
 * This fixture injects a generic subscription rejection. Bulk commit
 * reconciliation fixtures also exercise a real live-delivery failure.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { createTestContext, readSse, storedViewerKey } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { eventRoutes } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";

vi.mock("../pubsub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pubsub.js")>();
  return {
    ...actual,
    subscribeAll: () =>
      // eslint-disable-next-line require-yield -- the point of this one is that it rejects instead of yielding.
      (async function* () {
        await Promise.resolve();
        throw new Error("the subscription failed");
      })(),
  };
});

let ctx: TestContext;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ctx = await createTestContext();
  app = new Hono<AppEnv>();
  app.use("*", storedViewerKey(ctx));
  app.route("/events", eventRoutes(ctx.storage));
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a non-abort failure in the subscription", () => {
  it("tells the client and closes, instead of continuing quietly", async () => {
    const res = await app.request("/events");
    expect(res.status).toBe(200);

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"live_delivery_failed"');
  });
});
