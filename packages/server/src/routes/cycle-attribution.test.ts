/**
 * Route-layer integration tests for T-039 cycle metadata threading
 * (post-T-144).
 *
 * Verifies the full chain on the server side: cycle headers on the
 * inbound request → `cycleMiddleware` → `cycleRequestContext`
 * (AsyncLocalStorage) → every `publish(...)` call resolves the metadata
 * via ALS automatically → the emitted event carries the right
 * originator + hop → the reactive-run bridge / hop-budget gate receive
 * the right values. The wire-level contract these tests assert is
 * unchanged from T-039; T-144 only changed how routes propagate the
 * cycle internally.
 *
 * The SDK side (ConnectionClient stamping the headers in the first
 * place) is exercised in `runtime-sdk/src/connection-client.test.ts`.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { subscribe } from "../pubsub.js";
import type { ItemEventWithId } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

/** Drain pubsub events into an array until `predicate` matches. Resolves
 *  with the matched event or rejects after the timeout. The bridge
 *  tests use a similar pattern; copying it here avoids a shared
 *  test-utils widening that other suites would have to re-justify. */
async function nextEventMatching(
  predicate: (event: ItemEventWithId) => boolean,
  timeoutMs = 200,
): Promise<ItemEventWithId | null> {
  const iter = subscribe()[Symbol.asyncIterator]();
  const timeout = new Promise<null>((r) => {
    setTimeout(() => {
      r(null);
    }, timeoutMs);
  });
  const next = (async (): Promise<ItemEventWithId | null> => {
    for (;;) {
      const result = await iter.next();
      if (result.done) return null;
      if (predicate(result.value)) return result.value;
    }
  })();
  return Promise.race([next, timeout]).finally(() => {
    void iter.return(undefined);
  });
}

describe("cycle metadata attribution (T-039)", () => {
  it("propagates X-Myme-Cycle-Origin / X-Myme-Cycle-Hop headers onto the published event", async () => {
    const uniqueTitle = `cycle-attr-${Math.random().toString(36).slice(2, 8)}`;

    // Set up the listener BEFORE issuing the request so we don't miss
    // the synchronous emit.
    const eventP = nextEventMatching(
      (e) =>
        e.type === "created" &&
        (e.item.properties as { title?: string }).title === uniqueTitle,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: {
        "X-Myme-Cycle-Origin": "conn-upstream",
        "X-Myme-Cycle-Hop": "2",
      },
      body: {
        type: "core.task",
        properties: { title: uniqueTitle },
      },
    });
    expect(res.status).toBe(201);

    const event = await eventP;
    expect(event).not.toBeNull();
    expect(event?.originatingConnectionId).toBe("conn-upstream");
    expect(event?.hopCount).toBe(2);
  });

  it("stamps the human sentinel when the request carries no cycle headers", async () => {
    // Bootstrap admin without any connection binding — ordinary human
    // request. `cycleMiddleware`'s api-key fallback returns null
    // (test-admin source doesn't match `oauth:`/runtime-credential
    // shape), so the resulting publish is `{ originatingConnectionId:
    // null, hopCount: 0 }` — which `passesHopBudget` recognises as the
    // bypass shape.
    const uniqueTitle = `cycle-human-${Math.random().toString(36).slice(2, 8)}`;
    const eventP = nextEventMatching(
      (e) =>
        e.type === "created" &&
        (e.item.properties as { title?: string }).title === uniqueTitle,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.task",
        properties: { title: uniqueTitle },
      },
    });
    expect(res.status).toBe(201);

    const event = await eventP;
    expect(event).not.toBeNull();
    // Human sentinel: `passesHopBudget` recognises `originatingConnectionId
    // === null` as the chain-head bypass. The emitted event carries the
    // ALS-resolved value (null) verbatim post-T-144.
    expect(event?.originatingConnectionId ?? null).toBeNull();
    expect(event?.hopCount ?? 0).toBe(0);
  });
});
