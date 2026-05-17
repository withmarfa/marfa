/**
 * T-144 multi-hop integration test.
 *
 * The pre-existing `cycle-attribution.test.ts` covers individual hops
 * (a single inbound `X-Myme-Cycle-*` header pair → published event
 * carries the right origin / hop count). What it does not cover is a
 * full closed loop where the chain is conn-A → conn-B → conn-A → … and
 * the budget gate eventually trips. T-144 calls for that end-to-end
 * coverage in a single integration test.
 *
 * The test drives the loop by issuing successive `POST /items` requests
 * with mounting `X-Myme-Cycle-Hop` values under a fixed
 * `X-Myme-Cycle-Origin`, alternating an `X-Myme-Connector-Tag` (purely
 * informational — connection identity for the test reader; the server
 * resolves cycle metadata from headers regardless). Each step asserts
 * the emitted event's cycle stamp; the final overflow step asserts the
 * publish is dropped AND the `defaultCycleDetectionWiring` overflow
 * hook emits the `system.activity` row that the user surface reads.
 *
 * Implementation note: the server-side cycle middleware works from
 * headers — there's no requirement that the caller actually be a
 * runtime-credential api key for the loop to be exercised. Headers are
 * the contract the SDK threads on every reactive call, and they are the
 * authoritative path through `cycleMiddleware`. Using the bootstrap
 * admin + headers keeps the test self-contained and tenant-less; the
 * separate `cycle-attribution.test.ts` already covers the api-key
 * fallback resolution path explicitly.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  defaultCycleDetectionWiring,
  initEventLog,
  subscribe,
  __resetCycleDetectionForTests,
  DEFAULT_HOP_BUDGET,
} from "../pubsub.js";
import type { ItemEventWithId } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  __resetCycleDetectionForTests();
  ctx.cleanup();
});

beforeEach(() => {
  __resetCycleDetectionForTests();
});

/** Listen for the next `created` event matching `predicate`. Mirrors
 *  the helper in `cycle-attribution.test.ts`. */
async function nextCreatedMatching(
  predicate: (event: ItemEventWithId) => boolean,
  timeoutMs = 500,
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
      const value = result.value;
      if (value.type === "created" && predicate(value)) return value;
    }
  })();
  return Promise.race([next, timeout]).finally(() => {
    void iter.return(undefined);
  });
}

describe("cycle multi-hop A→B→A→… loop (T-144)", () => {
  it("propagates the same originator across alternating connector hops and trips the budget at the tail", async () => {
    // Install the production cycle-detection wiring so overflow emits
    // the `system.activity` row we'll assert at the end. Default
    // `getHopBudget` returns DEFAULT_HOP_BUDGET (5).
    initEventLog(
      ctx.storage.eventLog,
      defaultCycleDetectionWiring(ctx.storage),
    );

    const origin = `conn-loop-${Math.random().toString(36).slice(2, 8)}`;
    const baseTitle = `multi-hop-${Math.random().toString(36).slice(2, 8)}`;

    // Drive the loop: each iteration is one HTTP request that
    // simulates a connector reacting to the previous publish.
    // `hop=1` is conn-B reacting to conn-A's chain-head event;
    // `hop=2` is conn-A reacting back; and so on. The loop alternates
    // perspective but the originator stays pinned to conn-A — that's
    // the contract `nextHopMetadata` enforces SDK-side.
    const hops: number[] = [];
    for (let hop = 1; hop <= DEFAULT_HOP_BUDGET; hop += 1) {
      hops.push(hop);
    }

    for (const hop of hops) {
      const title = `${baseTitle}-hop-${String(hop)}`;
      const eventP = nextCreatedMatching(
        (e) => (e.item.properties as { title?: string }).title === title,
      );
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        headers: {
          "X-Myme-Cycle-Origin": origin,
          "X-Myme-Cycle-Hop": String(hop),
        },
        body: {
          type: "core.task",
          properties: { title },
        },
      });
      expect(res.status, `hop ${String(hop)} should succeed`).toBe(201);

      const event = await eventP;
      expect(event, `hop ${String(hop)} should emit an event`).not.toBeNull();
      expect(event?.originatingConnectionId).toBe(origin);
      expect(event?.hopCount).toBe(hop);
    }

    // Final hop: one beyond the budget. The HTTP write itself still
    // succeeds (item is created via storage), but `publish()` drops
    // the event under the budget gate and `defaultCycleDetectionWiring`
    // emits a system.activity row in its place.
    const overflowHop = DEFAULT_HOP_BUDGET + 1;
    const overflowTitle = `${baseTitle}-hop-${String(overflowHop)}`;
    const overflowEventP = nextCreatedMatching(
      (e) => (e.item.properties as { title?: string }).title === overflowTitle,
      150,
    );
    const overflowRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: {
        "X-Myme-Cycle-Origin": origin,
        "X-Myme-Cycle-Hop": String(overflowHop),
      },
      body: {
        type: "core.task",
        properties: { title: overflowTitle },
      },
    });
    expect(overflowRes.status).toBe(201);

    // No `created` event observed for the overflow hop — the budget
    // gate dropped the publish before the EventEmitter emit.
    expect(await overflowEventP).toBeNull();

    // The overflow hook writes a system.activity row. Poll for it —
    // the write is async (best-effort, fire-and-forget inside the
    // hook).
    const deadline = Date.now() + 1000;
    let matched:
      | Awaited<ReturnType<typeof ctx.storage.items.list>>["data"][number]
      | undefined;
    while (!matched && Date.now() < deadline) {
      const activities = await ctx.storage.items.list({
        type: "system.activity",
        limit: 50,
      });
      matched = activities.data.find(
        (a) =>
          a.properties.severity === "error" &&
          a.properties.connection_id === origin,
      );
      if (!matched) await new Promise((r) => setTimeout(r, 25));
    }
    expect(matched).toBeDefined();
    expect(
      (matched?.properties.detail as { hop_count?: number } | undefined)
        ?.hop_count,
    ).toBe(overflowHop);
    expect(
      (matched?.properties.detail as { budget?: number } | undefined)?.budget,
    ).toBe(DEFAULT_HOP_BUDGET);
  });
});
