/**
 * Route-layer integration tests for cycle metadata threading.
 *
 * Verifies the full chain on the server side: cycle headers on the
 * inbound request → `cycleMiddleware` → `cycleRequestContext`
 * (AsyncLocalStorage) → every `publish(...)` call resolves the metadata
 * via ALS automatically → the emitted event carries the right originator
 * + hop → the reactive-run bridge / hop-budget gate receive the right
 * values.
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

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Resolve with the first published event `predicate` accepts.
 *
 * Event-driven: the async iterator is awaited directly, so the wait ends
 * the instant the event is emitted. `deadlineMs` is therefore a *failure*
 * deadline, not a settle window — the happy path never waits it out, so it
 * is set generously enough that a loaded machine can't trip it, and
 * exceeding it means the event genuinely never arrived.
 *
 * Expiry rejects with `description` rather than resolving null, so a miss
 * says what it was waiting for instead of surfacing as an opaque
 * "expected null not to be null" at the assertion site.
 *
 * Ordering is load-bearing. `subscribe()` attaches its EventEmitter
 * listener on the first `iterator.next()` call and the emitter has no
 * replay buffer, so an event emitted before that call is lost forever.
 * Calling this function runs that first `next()` synchronously, which is
 * why every caller starts the listener before issuing the request that
 * publishes the event.
 *
 * The bridge tests use a similar pattern; copying it here avoids a shared
 * test-utils widening that other suites would have to re-justify.
 */
async function nextEventMatching(
  description: string,
  predicate: (event: ItemEventWithId) => boolean,
  deadlineMs = 15_000,
): Promise<ItemEventWithId> {
  const iter = subscribe()[Symbol.asyncIterator]();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    expiryTimer = setTimeout(() => {
      reject(
        new Error(
          `no published event matched ${description} within ${String(deadlineMs)}ms`,
        ),
      );
    }, deadlineMs);
  });
  const matched = (async (): Promise<ItemEventWithId> => {
    for (;;) {
      const result = await iter.next();
      if (result.done) {
        throw new Error(`pubsub stream closed before ${description} arrived`);
      }
      if (predicate(result.value)) return result.value;
    }
  })();
  // Closing the iterator below makes the in-flight `next()` resolve `done`,
  // which rejects `matched` after the race has already settled. Attach a
  // handler up front so that late rejection is never unhandled.
  void matched.catch(() => undefined);
  try {
    return await Promise.race([matched, expiry]);
  } finally {
    clearTimeout(expiryTimer);
    void iter.return(undefined);
  }
}

describe("cycle metadata attribution", () => {
  it("propagates X-Marfa-Cycle-Origin / X-Marfa-Cycle-Hop headers onto the published event", async () => {
    const uniqueTitle = `cycle-attr-${Math.random().toString(36).slice(2, 8)}`;

    // Set up the listener BEFORE issuing the request so we don't miss
    // the synchronous emit.
    const eventP = nextEventMatching(
      `the created event for "${uniqueTitle}"`,
      (e) =>
        e.type === "created" &&
        (e.item.properties as { title?: string }).title === uniqueTitle,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: {
        "X-Marfa-Cycle-Origin": "conn-upstream",
        "X-Marfa-Cycle-Hop": "2",
      },
      body: {
        type: "core.task",
        properties: { title: uniqueTitle },
      },
    });
    expect(res.status).toBe(201);

    const event = await eventP;
    expect(event.originatingConnectionId).toBe("conn-upstream");
    expect(event.hopCount).toBe(2);
  });

  it("stamps the human sentinel when the request carries no cycle headers", async () => {
    // Bootstrap admin without any connection binding — ordinary human
    // request. `cycleMiddleware`'s api-key fallback returns null
    // (test-admin source doesn't match `oauth:`/runtime-credential
    // shape), so the resulting publish is `{ originatingConnectionId:
    // null, hopCount: 0 }` — which `passesHopBudget` recognizes as the
    // bypass shape.
    const uniqueTitle = `cycle-human-${Math.random().toString(36).slice(2, 8)}`;
    // Listener first — see `nextEventMatching`; the emit is synchronous
    // and unbuffered.
    const eventP = nextEventMatching(
      `the created event for "${uniqueTitle}"`,
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
    // Human sentinel: `passesHopBudget` recognizes `originatingConnectionId
    // === null` as the chain-head bypass. The emitted event carries the
    // ALS-resolved value (null) verbatim.
    expect(event.originatingConnectionId ?? null).toBeNull();
    expect(event.hopCount ?? 0).toBe(0);
  });
});
