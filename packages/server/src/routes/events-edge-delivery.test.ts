/**
 * Edge delivery failing is the whole stream failing, not half of it going
 * quiet.
 *
 * The edge pump's rejection handler used to discard the error on the
 * grounds that cleanup handles termination. For the client leaving that
 * is true — cleanup has already run and the pending read rejects with the
 * abort. For anything else it is not: edge delivery ends permanently
 * while item delivery carries on over the same connection, so the client
 * keeps receiving events and never learns it has stopped hearing about
 * relationships. Half a stream that looks whole is the one shape a
 * durable client cannot detect, which is what makes silence the wrong
 * default here even though the failure is a rare one.
 *
 * No throw path in the edge subscription was identified in the tree, so
 * the rejection is injected. That is the point rather than a weakness of
 * the test: unreachable today is a property of the current callers, and
 * the handler is what decides what happens when one of them changes.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import type { ApiKey } from "@withmarfa/shared";
import { createTestContext, readSse } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { eventRoutes } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";

vi.mock("../pubsub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pubsub.js")>();
  return {
    ...actual,
    // Everything else stays real, including the emitter the item
    // subscription reads from: what is under test is one rejection, not
    // a reimplementation of the module.
    subscribeEdges: () =>
      // eslint-disable-next-line require-yield -- the point of this one is that it rejects instead of yielding.
      (async function* () {
        await Promise.resolve();
        throw new Error("edge subscription failed");
      })(),
  };
});

let ctx: TestContext;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ctx = await createTestContext();
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key-events-edge-failure",
      name: "edge viewer",
      key_hash: "unused",
      is_operator: true,
      type_permissions: { "*": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      created_at: new Date().toISOString(),
    } as unknown as ApiKey);
    await next();
  });
  app.route("/events", eventRoutes(ctx.storage));
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a non-abort failure in edge delivery", () => {
  it("tells the client and closes, instead of continuing quietly", async () => {
    const res = await app.request("/events");
    expect(res.status).toBe(200);

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"edge_delivery_failed"');
  });
});
