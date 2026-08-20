/**
 * Handler-level tests for the Task Auto-Archive integration.
 *
 * Builds ConnectionContext inline so the Marfa HTTP API doesn't need
 * to be reachable. The handler's listItems / transitionItem / getItem
 * calls are intercepted by a stub `ConnectionClient` whose backing
 * store is a small in-memory task list.
 */
import { describe, it, expect } from "vitest";
import {
  createCursorStore,
  createActivitySink,
  createEchoSuppression,
  type ConnectionContext,
  type ConnectionClient,
  type CreateItemInput,
  type ItemResource,
  type ListItemsQuery,
  type ListItemsPage,
  type ItemState,
  type ScheduleMessage,
  type ItemEventMessage,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import {
  handleSchedule,
  handleItemEvent,
  PAGE_SIZE,
  MAX_PAGES_PER_TICK,
} from "./handlers.js";
import { DEFAULT_ARCHIVE_AFTER_DAYS } from "./manifest.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function createMemoryStorage(): InMemoryStorage {
  const data = new Map<string, unknown>();
  return {
    get(key) {
      return Promise.resolve(data.get(key));
    },
    put(key, value) {
      data.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      return Promise.resolve(data.delete(key));
    },
  };
}

interface CapturedActivity {
  type: string;
  properties?: Record<string, unknown>;
}

interface BuildOpts {
  /** Pre-seeded core.task items (already in `state: active`). */
  tasks?: ItemResource[];
  /** Override archive_after_days via the connection record's
   *  configuration. */
  archiveAfterDays?: number;
  /** Make transitionItem reject for this task id. */
  failOnId?: string;
  /** Override the page size the stubbed listItems returns
   *  (defaults to PAGE_SIZE). */
  pageSize?: number;
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  /** Snapshot of task states after the run — task id → state. */
  finalStates: () => Map<string, ItemState>;
  transitionCalls: { id: string; to: ItemState }[];
}

function buildContext(opts: BuildOpts = {}): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const transitionCalls: { id: string; to: ItemState }[] = [];
  const tasks: ItemResource[] = (opts.tasks ?? []).map((t) => ({
    ...t,
    state: t.state ?? "active",
  }));
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const connectionId = "conn_taa_test";

  const client = {
    createItem: (input: CreateItemInput) => {
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
      }
      return Promise.resolve({ id: "act_x", type: input.type });
    },
    getItem: (id: string) => {
      if (id !== connectionId) return Promise.resolve(null);
      if (opts.archiveAfterDays === undefined) return Promise.resolve(null);
      return Promise.resolve({
        id: connectionId,
        type: "system.connection",
        properties: {
          configuration: { archive_after_days: opts.archiveAfterDays },
        },
      } as ItemResource);
    },
    listItems: (query: ListItemsQuery = {}): Promise<ListItemsPage> => {
      // Models real Marfa's cursor: opaque + stable across the
      // filter snapshot at the time of the original list call. Items
      // that mutate out of the filter between pages don't shift the
      // cursor (the cursor knows where it was within the original
      // snapshot, not its position in the freshly-filtered list).
      //
      // Implementation here: cursor encodes a numeric offset, and
      // we always re-filter from the current task list. This is a
      // faithful approximation as long as nothing mutates between
      // pages — exactly the contract the collect-then-act sweep
      // enforces from the handler side. A *separate* test exercises
      // the offset hazard with mutations interleaved.
      const offset = query.cursor === undefined ? 0 : Number(query.cursor);
      const filtered = tasks
        .filter(
          (t) => t.type === query.type && (t.state ?? "active") === query.state,
        )
        .sort((a, b) => {
          const ams = a.created_at ? Date.parse(a.created_at) : 0;
          const bms = b.created_at ? Date.parse(b.created_at) : 0;
          return ams - bms;
        });
      const slice = filtered.slice(offset, offset + pageSize);
      const nextOffset = offset + slice.length;
      const has_more = nextOffset < filtered.length;
      return Promise.resolve({
        data: slice,
        cursor: has_more ? String(nextOffset) : null,
        has_more,
      });
    },
    transitionItem: (id: string, to: ItemState): Promise<ItemResource> => {
      transitionCalls.push({ id, to });
      if (opts.failOnId === id) {
        return Promise.reject(new Error("server 500"));
      }
      const t = tasks.find((x) => x.id === id);
      if (t) t.state = to;
      return Promise.resolve(t ?? { id, type: "core.task", state: to });
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "withmarfa.task-auto-archive",
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, { echo_ttl_seconds: 60 }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return {
    ctx,
    emitted,
    transitionCalls,
    finalStates: () => {
      const m = new Map<string, ItemState>();
      for (const t of tasks) m.set(t.id, t.state ?? "active");
      return m;
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEDULE_MSG = (ms: number): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "withmarfa.task-auto-archive",
  connection_id: "conn_taa_test",
  scheduled_for_ms: ms,
});

const ITEM_EVENT_MSG = (eventType: string): ItemEventMessage => ({
  kind: "item-event",
  integration_name: "withmarfa.task-auto-archive",
  connection_id: "conn_taa_test",
  event_type: eventType,
  item_id: "task_other",
  cycle: { originating_connection_id: "conn_other", hop_count: 1 },
  payload: {},
});

function task(id: string, ageDays: number, nowMs: number): ItemResource {
  return {
    id,
    type: "core.task",
    state: "active",
    created_at: new Date(nowMs - ageDays * DAY_MS).toISOString(),
  };
}

describe("task-auto-archive handlers", () => {
  it("schedule sweep archives only tasks older than the default cutoff", async () => {
    const now = 1_700_000_000_000;
    const tasks = [
      task("t_10d", 10, now),
      task("t_35d", 35, now),
      task("t_90d", 90, now),
    ];
    const { ctx, emitted, finalStates } = buildContext({ tasks });

    const result = await handleSchedule(ctx, SCHEDULE_MSG(now));
    expect(result).toEqual({ ok: true });
    const states = finalStates();
    expect(states.get("t_10d")).toBe("active");
    expect(states.get("t_35d")).toBe("archived");
    expect(states.get("t_90d")).toBe("archived");

    const summary = emitted.at(-1);
    expect(summary?.properties?.summary).toBe(
      "task-auto-archive archived 2 task(s) (schedule)",
    );
    expect(summary?.properties?.detail).toMatchObject({
      archive_after_days: DEFAULT_ARCHIVE_AFTER_DAYS,
      archived: 2,
      stop_reason: "no_more_due",
    });
  });

  it("item-event sweep archives the same set", async () => {
    const now = Date.now();
    const tasks = [task("t_50d", 50, now), task("t_5d", 5, now)];
    const { ctx, finalStates } = buildContext({ tasks });

    await handleItemEvent(ctx, ITEM_EVENT_MSG("updated"));
    const states = finalStates();
    expect(states.get("t_50d")).toBe("archived");
    expect(states.get("t_5d")).toBe("active");
  });

  it("respects archive_after_days from connection configuration", async () => {
    const now = 1_700_000_000_000;
    const tasks = [task("t_10d", 10, now), task("t_3d", 3, now)];
    const { ctx, emitted, finalStates } = buildContext({
      tasks,
      archiveAfterDays: 7,
    });

    await handleSchedule(ctx, SCHEDULE_MSG(now));
    const states = finalStates();
    expect(states.get("t_10d")).toBe("archived");
    expect(states.get("t_3d")).toBe("active");

    expect(emitted.at(-1)?.properties?.detail).toMatchObject({
      archive_after_days: 7,
    });
  });

  it("stops early on the first non-due task (ascending-sort optimization)", async () => {
    const now = 1_700_000_000_000;
    // 200d, 100d are due; 5d is not. Handler should stop at 5d.
    const tasks = [
      task("t_200", 200, now),
      task("t_100", 100, now),
      task("t_5", 5, now),
    ];
    const { ctx, transitionCalls, emitted } = buildContext({ tasks });
    await handleSchedule(ctx, SCHEDULE_MSG(now));

    expect(transitionCalls.map((c) => c.id)).toEqual(["t_200", "t_100"]);
    expect(emitted.at(-1)?.properties?.detail).toMatchObject({
      stop_reason: "no_more_due",
      archived: 2,
    });
  });

  it("continues past per-task transition failures", async () => {
    const now = 1_700_000_000_000;
    const tasks = [
      task("t_a", 50, now),
      task("t_b", 60, now),
      task("t_c", 70, now),
    ];
    const { ctx, finalStates, emitted } = buildContext({
      tasks,
      failOnId: "t_b",
    });

    await handleSchedule(ctx, SCHEDULE_MSG(now));
    const states = finalStates();
    expect(states.get("t_a")).toBe("archived");
    expect(states.get("t_b")).toBe("active"); // failed
    expect(states.get("t_c")).toBe("archived");

    const required = emitted.filter(
      (e) => e.properties?.severity === "action_required",
    );
    expect(required).toHaveLength(1);
    expect(required[0]?.properties?.summary).toMatch(
      /failed to archive task t_b/,
    );
  });

  it("walks multiple pages when more results are available", async () => {
    const now = 1_700_000_000_000;
    // 4 tasks, page size 2 → 2 pages.
    const tasks = [
      task("t_a", 100, now),
      task("t_b", 90, now),
      task("t_c", 80, now),
      task("t_d", 70, now),
    ];
    const { ctx, transitionCalls, emitted } = buildContext({
      tasks,
      pageSize: 2,
    });

    await handleSchedule(ctx, SCHEDULE_MSG(now));
    expect(transitionCalls.map((c) => c.id)).toEqual([
      "t_a",
      "t_b",
      "t_c",
      "t_d",
    ]);
    expect(emitted.at(-1)?.properties?.detail).toMatchObject({
      pages_walked: 2,
      stop_reason: "complete",
    });
  });

  it("stops at MAX_PAGES_PER_TICK and reports page_cap", async () => {
    const now = 1_700_000_000_000;
    // (MAX_PAGES_PER_TICK + 1) * pageSize tasks all due — handler caps.
    const totalTasks = (MAX_PAGES_PER_TICK + 1) * 2;
    const tasks = Array.from({ length: totalTasks }, (_, i) =>
      task(`t_${String(i)}`, 100 - i, now),
    );
    const { ctx, transitionCalls, emitted } = buildContext({
      tasks,
      pageSize: 2,
    });

    await handleSchedule(ctx, SCHEDULE_MSG(now));
    expect(transitionCalls.length).toBe(MAX_PAGES_PER_TICK * 2);
    expect(emitted.at(-1)?.properties?.detail).toMatchObject({
      pages_walked: MAX_PAGES_PER_TICK,
      stop_reason: "page_cap",
    });
  });

  it("emits an info activity even when nothing is due", async () => {
    const now = 1_700_000_000_000;
    const { ctx, emitted } = buildContext({ tasks: [task("t_5", 5, now)] });
    await handleSchedule(ctx, SCHEDULE_MSG(now));
    const summary = emitted.at(-1);
    expect(summary?.properties?.summary).toBe(
      "task-auto-archive sweep — nothing due (schedule)",
    );
    expect(summary?.properties?.detail).toMatchObject({
      archived: 0,
      stop_reason: "no_more_due",
    });
  });

  it("processes every due row even with an offset-based cursor", async () => {
    // Real Marfa returns an opaque keyset cursor that's stable across
    // in-place state changes. Transitioning items inside the pagination
    // loop relies on that property — if a cursor change made it
    // offset-based, page 2 would call `slice(offset, offset + size)`
    // against a freshly-filtered list whose offset now points past
    // unprocessed rows, and half the rows would be skipped.
    //
    // The sweep is collect-then-act: all listItems calls finish before
    // any transitions happen. This test stubs listItems with
    // offset-based behavior and asserts every due row is still archived.
    const now = 1_700_000_000_000;
    const tasks = [
      task("t_a", 100, now),
      task("t_b", 90, now),
      task("t_c", 80, now),
      task("t_d", 70, now),
    ];
    const pageSize = 2;
    const archived: string[] = [];
    const transitionCalls: { id: string; to: ItemState }[] = [];
    const emitted: CapturedActivity[] = [];
    const storage = createMemoryStorage();

    // Custom client where listItems is offset-based: cursor encodes
    // the offset into the *current* (post-mutation) filtered list.
    // With a transition-inside-loop handler this would skip rows;
    // with collect-then-act the offset doesn't move because nothing
    // mutates between pages.
    const client = {
      createItem: (input: CreateItemInput) => {
        if (input.type === "system.activity") {
          emitted.push({ type: input.type, properties: input.properties });
        }
        return Promise.resolve({ id: "act_x", type: input.type });
      },
      getItem: () => Promise.resolve(null),
      listItems: (query: ListItemsQuery = {}): Promise<ListItemsPage> => {
        const offset = query.cursor === undefined ? 0 : Number(query.cursor);
        const filtered = tasks
          .filter(
            (t) =>
              t.type === query.type && (t.state ?? "active") === query.state,
          )
          .sort((a, b) => {
            const ams = a.created_at ? Date.parse(a.created_at) : 0;
            const bms = b.created_at ? Date.parse(b.created_at) : 0;
            return ams - bms;
          });
        const slice = filtered.slice(offset, offset + pageSize);
        const nextOffset = offset + slice.length;
        const has_more = nextOffset < filtered.length;
        return Promise.resolve({
          data: slice,
          cursor: has_more ? String(nextOffset) : null,
          has_more,
        });
      },
      transitionItem: (id: string, to: ItemState): Promise<ItemResource> => {
        transitionCalls.push({ id, to });
        archived.push(id);
        const t = tasks.find((x) => x.id === id);
        if (t) t.state = to;
        return Promise.resolve(t ?? { id, type: "core.task", state: to });
      },
    } as unknown as ConnectionClient;

    const ctx: ConnectionContext = {
      connection_id: "conn_taa_test",
      integration_name: "withmarfa.task-auto-archive",
      marfa: client,
      cursor: createCursorStore(storage),
      activity: createActivitySink(client, "conn_taa_test"),
      echo: createEchoSuppression(storage, { echo_ttl_seconds: 60 }),
      mapping: familyOnlyMappingResolver(),
      cycle: null,
    };

    await handleSchedule(ctx, SCHEDULE_MSG(now));

    // All four tasks must be archived. Without collect-then-act,
    // offset-based pagination would skip t_c and t_d on page 2.
    expect(archived.sort()).toEqual(["t_a", "t_b", "t_c", "t_d"]);
    expect(transitionCalls).toHaveLength(4);
    expect(emitted.at(-1)?.properties?.detail).toMatchObject({
      archived: 4,
      pages_walked: 2,
      stop_reason: "complete",
    });
  });
});
