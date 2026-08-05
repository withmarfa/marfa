import {
  describe,
  expect,
  it,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { createTestContext } from "./test-utils.js";
import type { TestContext } from "./test-utils.js";
import {
  initEventLog,
  publish,
  publishEdge,
  nextHopMetadata,
  defaultCycleDetectionWiring,
  __resetCycleDetectionForTests,
  DEFAULT_HOP_BUDGET,
} from "./pubsub.js";
import { cycleRequestContext } from "./cycle-context.js";
import type { Item, Edge } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
  __resetCycleDetectionForTests();
});

beforeEach(() => {
  __resetCycleDetectionForTests();
});

afterEach(() => {
  __resetCycleDetectionForTests();
});

function fakeItem(id: string, type = "core.note"): Item {
  const now = new Date().toISOString();
  return {
    id,
    type,
    state: "active",
    properties: {},
    created_at: now,
    updated_at: now,
    timestamp: now,
    source: "test",
    version: 1,
    schema_version: 1,
  };
}

function fakeEdge(id: string): Edge {
  const now = new Date().toISOString();
  return {
    id,
    source_id: "src",
    target_id: "tgt",
    edge_type: "about",
    properties: {},
    created_at: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// nextHopMetadata helper
// ---------------------------------------------------------------------------

describe("nextHopMetadata", () => {
  it("starts a chain when called with no parent metadata", () => {
    const meta = nextHopMetadata({}, "conn-1");
    expect(meta.hopCount).toBe(1);
    expect(meta.originatingConnectionId).toBe("conn-1");
  });

  it("propagates the originating connection through the chain", () => {
    const first = nextHopMetadata({}, "conn-1");
    const second = nextHopMetadata(first, "conn-2");
    expect(second.hopCount).toBe(2);
    // originating stays the connection that *kicked off* the chain.
    expect(second.originatingConnectionId).toBe("conn-1");
  });

  it("handles a human-initiated parent with no current connection", () => {
    const meta = nextHopMetadata({});
    expect(meta.hopCount).toBe(1);
    expect(meta.originatingConnectionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("publish — persistence", () => {
  it("stamps hop_count and originating_connection_id on the event_log row", async () => {
    initEventLog(ctx.storage.eventLog);
    const item = fakeItem("item-A");
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    await publish({
      type: "created",
      item,
      spaceId: undefined,
      originatingConnectionId: "conn-X",
      hopCount: 1,
    });

    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const last = after.at(-1);
    expect(last).toBeDefined();
    expect(last?.hop_count).toBe(1);
    expect(last?.originating_connection_id).toBe("conn-X");
  });

  it("defaults hop_count to 0 + originating_connection_id to null for human-initiated events", async () => {
    initEventLog(ctx.storage.eventLog);
    const item = fakeItem("item-B");
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    await publish({ type: "created", item });

    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const last = after.at(-1);
    expect(last?.hop_count).toBe(0);
    expect(last?.originating_connection_id).toBeNull();
  });

  it("propagates metadata onto edge events too", async () => {
    initEventLog(ctx.storage.eventLog);
    const edge = fakeEdge("edge-1");
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    await publishEdge({
      type: "edge_created",
      edge,
      originatingConnectionId: "conn-Y",
      hopCount: 2,
    });

    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const last = after.at(-1);
    expect(last?.hop_count).toBe(2);
    expect(last?.originating_connection_id).toBe("conn-Y");
    expect(last?.edge_id).toBe("edge-1");
  });
});

// ---------------------------------------------------------------------------
// Hop-budget enforcement
// ---------------------------------------------------------------------------

describe("publish — hop budget enforcement", () => {
  it("drops events whose hopCount exceeds the budget and fires the overflow hook", async () => {
    const overflow = vi.fn(() => Promise.resolve());
    initEventLog(ctx.storage.eventLog, {
      getHopBudget: () => Promise.resolve(2),
      onHopOverflow: overflow,
    });

    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    const result = await publish({
      type: "created",
      item: fakeItem("item-overflow"),
      hopCount: 3,
      originatingConnectionId: "conn-overflow",
    });

    expect(result).toBeUndefined();
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(overflow).toHaveBeenCalledWith(
      expect.objectContaining({
        hopCount: 3,
        originatingConnectionId: "conn-overflow",
      }),
      2,
    );

    // Verify nothing was appended to event_log.
    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const matched = after.find(
      (r) =>
        r.originating_connection_id === "conn-overflow" && r.hop_count === 3,
    );
    expect(matched).toBeUndefined();
  });

  it("admits events whose hopCount equals the budget exactly", async () => {
    initEventLog(ctx.storage.eventLog, {
      getHopBudget: () => Promise.resolve(2),
    });

    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    const eid = await publish({
      type: "created",
      item: fakeItem("item-edge-of-budget"),
      hopCount: 2,
      originatingConnectionId: "conn-edge",
    });

    expect(eid).toBeDefined();
    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const matched = after.find(
      (r) => r.originating_connection_id === "conn-edge",
    );
    expect(matched?.hop_count).toBe(2);
  });

  it("uses DEFAULT_HOP_BUDGET when no overrides are wired", async () => {
    expect(DEFAULT_HOP_BUDGET).toBe(5);
    initEventLog(ctx.storage.eventLog);

    // hopCount = 6 should overflow the default budget of 5.
    const result = await publish({
      type: "created",
      item: fakeItem("item-default-overflow"),
      hopCount: 6,
    });
    expect(result).toBeUndefined();
  });

  it("enforces budget on integration-originated events even when hopCount=0", async () => {
    // A misbehaving integration that stamps `originatingConnectionId` but
    // leaves hopCount at 0 must not slip past the budget. The fix
    // attributes by origin presence — effective hopCount floors at 1.
    const overflow = vi.fn(() => Promise.resolve());
    initEventLog(ctx.storage.eventLog, {
      // Budget of 0 — any integration-originated event should overflow.
      getHopBudget: () => Promise.resolve(0),
      onHopOverflow: overflow,
    });

    const result = await publish({
      type: "created",
      item: fakeItem("item-misbehaving-integration"),
      hopCount: 0,
      originatingConnectionId: "conn-misbehaving",
    });

    expect(result).toBeUndefined();
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it("admits human-originated events with no origin and hopCount=0", async () => {
    // A human caller MUST omit both fields — the budget bypass for that
    // shape stays in place. Regression in case the new attribution logic
    // accidentally narrowed it.
    const overflow = vi.fn(() => Promise.resolve());
    initEventLog(ctx.storage.eventLog, {
      // Even a budget of 0 must not block human publishes.
      getHopBudget: () => Promise.resolve(0),
      onHopOverflow: overflow,
    });

    const eid = await publish({
      type: "created",
      item: fakeItem("item-human-publish"),
    });

    expect(eid).toBeDefined();
    expect(overflow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// defaultCycleDetectionWiring — system.activity emission
// ---------------------------------------------------------------------------

describe("defaultCycleDetectionWiring — overflow emits system.activity", () => {
  it("writes a system.activity row with severity error when budget is exceeded", async () => {
    const wiring = defaultCycleDetectionWiring(ctx.storage);
    initEventLog(ctx.storage.eventLog, {
      ...wiring,
      getHopBudget: () => Promise.resolve(1),
    });

    await publish({
      type: "created",
      item: fakeItem("item-overflow-activity"),
      hopCount: 5,
      originatingConnectionId: "conn-loud",
    });

    // Activity emitted directly via storage.items.create — bypasses
    // pubsub so it doesn't itself loop.
    const activities = await ctx.storage.items.list({
      type: "system.activity",
      limit: 50,
    });
    const matched = activities.data.find(
      (a) =>
        a.properties.severity === "error" &&
        a.properties.connection_id === "conn-loud",
    );
    expect(matched).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §3.9 — getHopBudget caches per-space lookups
// ---------------------------------------------------------------------------

describe("defaultCycleDetectionWiring — per-space hop-budget cache", () => {
  it("does not hit storage.spaces.getConfig twice for the same space within the TTL window", async () => {
    let getConfigCalls = 0;
    // Fake a storage shape with just enough surface for the wiring.
    // The cache lives inside `defaultCycleDetectionWiring`'s closure,
    // so a fresh wiring instance is what's under test.
    const fakeStorage = {
      spaces: {
        getConfig: () => {
          getConfigCalls += 1;
          return Promise.resolve({ max_event_hop_budget: 7 });
        },
      },
    } as unknown as Parameters<typeof defaultCycleDetectionWiring>[0];

    const wiring = defaultCycleDetectionWiring(fakeStorage);
    expect(wiring.getHopBudget).toBeDefined();
    const getHop = wiring.getHopBudget!;

    expect(await getHop("space-a")).toBe(7);
    expect(await getHop("space-a")).toBe(7);
    expect(await getHop("space-a")).toBe(7);
    expect(getConfigCalls).toBe(1);

    // Different space id → fresh storage hit.
    expect(await getHop("space-b")).toBe(7);
    expect(getConfigCalls).toBe(2);

    // Undefined spaceId → constant default, no storage hit.
    expect(await getHop(undefined)).toBe(DEFAULT_HOP_BUDGET);
    expect(getConfigCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ALS-driven cycle resolution
// ---------------------------------------------------------------------------

describe("publish — cycle resolution from cycleRequestContext", () => {
  it("reads cycle metadata from the ALS when the event arg omits it", async () => {
    initEventLog(ctx.storage.eventLog);
    const item = fakeItem("item-als-resolved");
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    await cycleRequestContext.run(
      { originatingConnectionId: "conn-via-als", hopCount: 1 },
      async () => {
        await publish({ type: "created", item });
      },
    );

    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const last = after.at(-1);
    expect(last?.originating_connection_id).toBe("conn-via-als");
    expect(last?.hop_count).toBe(1);
  });

  it("falls back to the human sentinel when called outside any ALS context", async () => {
    initEventLog(ctx.storage.eventLog);
    const item = fakeItem("item-no-als");
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    await publish({ type: "created", item });

    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const last = after.at(-1);
    expect(last?.originating_connection_id).toBeNull();
    expect(last?.hop_count).toBe(0);
  });

  it("explicit cycle fields on the event arg override the ALS", async () => {
    initEventLog(ctx.storage.eventLog);
    const item = fakeItem("item-explicit-override");
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    await cycleRequestContext.run(
      { originatingConnectionId: "conn-als-loser", hopCount: 9 },
      async () => {
        await publish({
          type: "created",
          item,
          originatingConnectionId: "conn-explicit-winner",
          hopCount: 2,
        });
      },
    );

    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const last = after.at(-1);
    expect(last?.originating_connection_id).toBe("conn-explicit-winner");
    expect(last?.hop_count).toBe(2);
  });

  it("publishEdge resolves cycle from the ALS the same way publish does", async () => {
    initEventLog(ctx.storage.eventLog);
    const edge = fakeEdge("edge-als");
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const maxBefore = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b), 0n)
      : 0n;

    await cycleRequestContext.run(
      { originatingConnectionId: "conn-edge-als", hopCount: 3 },
      async () => {
        await publishEdge({ type: "edge_created", edge });
      },
    );

    const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
    const last = after.at(-1);
    expect(last?.edge_id).toBe("edge-als");
    expect(last?.originating_connection_id).toBe("conn-edge-als");
    expect(last?.hop_count).toBe(3);
  });

  it("ALS-resolved integration-originated event with hopCount=0 still enforces the budget floor", async () => {
    // Wire-tampering defense (`Math.max(hopCount, 1)`) survives the ALS
    // refactor. An ALS context with origin set + hopCount=0 (the chain-
    // head shape a runtime credential request resolves to) is fine at
    // ordinary budgets but must overflow at budget=0.
    const overflow = vi.fn(() => Promise.resolve());
    initEventLog(ctx.storage.eventLog, {
      getHopBudget: () => Promise.resolve(0),
      onHopOverflow: overflow,
    });

    let result: bigint | undefined;
    await cycleRequestContext.run(
      { originatingConnectionId: "conn-floor-via-als", hopCount: 0 },
      async () => {
        result = await publish({
          type: "created",
          item: fakeItem("item-als-floor"),
        });
      },
    );

    expect(result).toBeUndefined();
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(overflow).toHaveBeenCalledWith(
      expect.objectContaining({
        originatingConnectionId: "conn-floor-via-als",
        hopCount: 0,
      }),
      0,
    );
  });
});
