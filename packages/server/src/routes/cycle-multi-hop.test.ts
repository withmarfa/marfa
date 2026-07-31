/**
 * Multi-hop cycle integration test.
 *
 * The `cycle-attribution.test.ts` covers individual hops (a single
 * inbound `X-Marfa-Cycle-*` header pair → published event carries the
 * right origin / hop count). This test covers a full closed loop where
 * the chain is conn-A → conn-B → conn-A → … and the budget gate
 * eventually trips.
 *
 * The test drives the loop by issuing successive `POST /items` requests
 * with mounting `X-Marfa-Cycle-Hop` values under a fixed
 * `X-Marfa-Cycle-Origin`, alternating an `X-Marfa-Connector-Tag` (purely
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
 * admin + headers keeps the test self-contained and space-less; the
 * separate `cycle-attribution.test.ts` already covers the api-key
 * fallback resolution path explicitly.
 */
import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
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

afterAll(async () => {
  __resetCycleDetectionForTests();
  await ctx.cleanup();
});

// The positive waits have no deadline of their own, so this is the failure
// bound for the whole file. Generous on purpose: it decides how long a
// genuinely missing event takes to report, and nothing else.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  __resetCycleDetectionForTests();
});

/**
 * Listen for the next `created` event matching `predicate`.
 *
 * No internal deadline. This used to race the event against 500 ms and
 * resolve `null`, which turned "the machine was busy" into
 * `expected null not to be null` — an assertion failure naming a property
 * that was never actually tested. That is the worst shape a flake can take:
 * it reads as a defect in the code under test, and it cost a red merge on a
 * commit that changed a hostname in a fixture.
 *
 * The bound is the suite timeout below instead, so a genuinely missing event
 * fails as a timeout, which is what it is.
 */
async function nextCreatedMatching(
  predicate: (event: ItemEventWithId) => boolean,
): Promise<ItemEventWithId | null> {
  const iter = subscribe()[Symbol.asyncIterator]();
  try {
    for (;;) {
      const result = await iter.next();
      if (result.done) return null;
      const value = result.value;
      if (value.type === "created" && predicate(value)) return value;
    }
  } finally {
    void iter.return(undefined);
  }
}

/**
 * Wait a bounded time and assert nothing matching arrives.
 *
 * A negative assertion needs a deadline — you cannot wait forever for an
 * absence — but it is the one shape that fails in the *passing* direction: a
 * loaded machine makes a late event more likely to be missed, so too tight a
 * bound reports success for the wrong reason. This is deliberately far longer
 * than the publish path takes, so an event the gate should have dropped has
 * every chance to show up and fail the test.
 */
async function noCreatedMatchingWithin(
  predicate: (event: ItemEventWithId) => boolean,
  withinMs: number,
): Promise<ItemEventWithId | null> {
  const timeout = new Promise<null>((r) => {
    setTimeout(() => {
      r(null);
    }, withinMs);
  });
  return Promise.race([nextCreatedMatching(predicate), timeout]);
}

describe("cycle multi-hop A→B→A→… loop", () => {
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
          "X-Marfa-Cycle-Origin": origin,
          "X-Marfa-Cycle-Hop": String(hop),
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
    const overflowEventP = noCreatedMatchingWithin(
      (e) => (e.item.properties as { title?: string }).title === overflowTitle,
      2_000,
    );
    const overflowRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: {
        "X-Marfa-Cycle-Origin": origin,
        "X-Marfa-Cycle-Hop": String(overflowHop),
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

    // The overflow hook writes a system.activity row. Poll for it — the
    // write is async (best-effort, fire-and-forget inside the hook). The
    // deadline is a failure bound, not a pause: the happy path returns on the
    // first pass, and a tight one would only mean a busy machine reports a
    // missing row that was on its way.
    const deadline = Date.now() + 10_000;
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
