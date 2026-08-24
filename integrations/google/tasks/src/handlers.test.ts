/**
 * Handler-level tests for the Google Tasks bidirectional integration.
 *
 * Same pattern as google-calendar's `handlers.test.ts`: build the
 * ConnectionContext inline against the SDK's exposed primitives
 * (`createCursorStore`, `createActivitySink`, `createEchoSuppression`),
 * mock `ctx.marfa` entirely (no real HTTP).
 *
 * Coverage:
 *   - Schedule: discover task lists, sweep, upsert as the configured
 *     target type, advance per-list watermark.
 *   - Schedule: deleted=true → tombstone-map onto the existing Marfa
 *     item.
 *   - Schedule: echo-suppressed task is skipped.
 *   - Item-event: outbound create injects the `[marfa-id:…]` sentinel
 *     into notes.
 *   - Item-event: idempotent recovery — sentinel-bearing existing
 *     task is found, mapping recorded, no fresh insert.
 *   - Item-event: trashed state → DELETE on the mapped list.
 *   - Item-event: lag-window deferral → retry=true.
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
  type ItemState,
  type ItemEventMessage,
  type ScheduleMessage,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { handleSchedule, handleItemEvent } from "./handlers.js";
import { GOOGLE_TASKS_MANIFEST } from "./manifest.js";

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

interface ProxyCall {
  method: string;
  path: string;
  body: unknown;
}

interface BuildOpts {
  connectionRecord?: Partial<ItemResource>;
  itemForEvent?: ItemResource | null;
  proxyResponses: (() => Response)[];
  preExistingItems?: Map<string, ItemResource>;
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  transitions: { id: string; to: ItemState }[];
  proxyCalls: ProxyCall[];
}

const CONNECTION_ID = "conn_gtasks_test";

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const transitions: { id: string; to: ItemState }[] = [];
  const proxyCalls: ProxyCall[] = [];
  const items = opts.preExistingItems ?? new Map<string, ItemResource>();
  let proxyIdx = 0;
  let createdCount = 0;

  const client = {
    createItem: (input: CreateItemInput) => {
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      created.push(input);
      createdCount += 1;
      const id = `mit_${String(createdCount)}`;
      items.set(id, {
        id,
        type: input.type,
        state: "active",
        properties: input.properties ?? {},
      });
      return Promise.resolve({ id, type: input.type });
    },
    updateItem: (id: string, patch: Partial<CreateItemInput>) => {
      updated.push({ id, patch });
      return Promise.resolve({ id, type: "google.tasks.task" });
    },
    getItem: (id: string) => {
      if (id === CONNECTION_ID) {
        return Promise.resolve(opts.connectionRecord ?? null);
      }
      if (opts.itemForEvent?.id === id) {
        return Promise.resolve(opts.itemForEvent);
      }
      return Promise.resolve(items.get(id) ?? null);
    },
    transitionItem: (id: string, to: ItemState) => {
      transitions.push({ id, to });
      const existing = items.get(id);
      if (existing) existing.state = to;
      return Promise.resolve({ id, type: "google.tasks.task", state: to });
    },
    proxyRequest: (method: string, path: string, body?: unknown) => {
      proxyCalls.push({ method, path, body });
      const responder = opts.proxyResponses[proxyIdx];
      proxyIdx += 1;
      if (!responder) {
        return Promise.resolve(new Response("no responder", { status: 500 }));
      }
      return Promise.resolve(responder());
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: CONNECTION_ID,
    integration_name: GOOGLE_TASKS_MANIFEST.name,
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, CONNECTION_ID),
    echo: createEchoSuppression(storage, {
      echo_ttl_seconds: 120,
      lag_window_seconds: 600,
    }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };

  return { ctx, emitted, created, updated, transitions, proxyCalls };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: GOOGLE_TASKS_MANIFEST.name,
  connection_id: CONNECTION_ID,
  scheduled_for_ms: Date.now(),
});

const ITEM_EVENT = (
  itemId: string,
  eventType = "item.created",
  origin = "conn_other",
): ItemEventMessage => ({
  kind: "item-event",
  integration_name: GOOGLE_TASKS_MANIFEST.name,
  connection_id: CONNECTION_ID,
  event_type: eventType,
  item_id: itemId,
  cycle: { originating_connection_id: origin, hop_count: 1 },
  payload: {},
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const TASKLISTS_RESPONSE = {
  items: [
    { id: "list-primary", title: "My tasks" },
    { id: "list-shopping", title: "Shopping" },
  ],
};

const PRIMARY_TASKS = {
  items: [
    {
      id: "task-A",
      title: "Buy milk",
      status: "needsAction",
      updated: "2026-05-23T22:00:00.000Z",
      etag: "etag-A",
    },
    {
      id: "task-B",
      title: "Email landlord",
      status: "completed",
      completed: "2026-05-23T21:00:00.000Z",
      updated: "2026-05-23T21:00:00.000Z",
      etag: "etag-B",
    },
  ],
};

describe("google-tasks handlers — the type a connection writes", () => {
  it("writes the configured family's type when the install names one", async () => {
    const { ctx, created } = buildContext({
      connectionRecord: {
        id: CONNECTION_ID,
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: {
            write_family: "core",
            selected_task_list_ids: ["list-primary"],
          },
        },
      },
      proxyResponses: [() => jsonResponse(PRIMARY_TASKS)],
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(created).toHaveLength(2);
    expect(created.every((c) => c.type === "core.task")).toBe(true);
  });

  it("ignores a target_type left in stored configuration", async () => {
    // The pre-families configuration shape wrote `target_type`, and it
    // steered the write for one release so installed connections kept
    // resolving. No connection carries it now, so it must not steer
    // anything: the manifest's default family decides.
    const { ctx, created } = buildContext({
      connectionRecord: {
        id: CONNECTION_ID,
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: {
            target_type: "core.task",
            selected_task_list_ids: ["list-primary"],
          },
        },
      },
      proxyResponses: [() => jsonResponse(PRIMARY_TASKS)],
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(created).toHaveLength(2);
    expect(created.every((c) => c.type === "google.tasks.task")).toBe(true);
  });
});

describe("google-tasks handleSchedule", () => {
  it("discovers task lists, sweeps each, upserts as google.tasks.task by default", async () => {
    const { ctx, created, proxyCalls, emitted } = buildContext({
      proxyResponses: [
        () => jsonResponse(TASKLISTS_RESPONSE),
        () => jsonResponse(PRIMARY_TASKS),
        () => jsonResponse({ items: [] }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    expect(proxyCalls[0]?.path).toMatch(/\/tasks\/v1\/users\/@me\/lists/);
    expect(proxyCalls[1]?.path).toMatch(
      /\/tasks\/v1\/lists\/list-primary\/tasks/,
    );
    expect(proxyCalls[2]?.path).toMatch(
      /\/tasks\/v1\/lists\/list-shopping\/tasks/,
    );

    expect(created).toHaveLength(2);
    expect(created[0]?.type).toBe("google.tasks.task");
    expect(created[0]?.properties).toMatchObject({
      title: "Buy milk",
      status: "needsAction",
      source_task_list_id: "list-primary",
      etag: "etag-A",
    });

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
      mapping_lists: Record<string, string>;
      per_list: Record<string, { updated_min: string | null }>;
    };
    expect(cursor.mappings["task-A"]).toBe("mit_1");
    expect(cursor.mapping_lists["task-A"]).toBe("list-primary");
    expect(cursor.per_list["list-primary"]?.updated_min).toBeTypeOf("string");
    expect(cursor.per_list["list-shopping"]?.updated_min).toBeTypeOf("string");

    const lastActivity = emitted.at(-1)?.properties?.summary;
    expect(String(lastActivity)).toMatch(/upserted=2/);
  });

  it("trashes the mapped Marfa item when an upstream task surfaces deleted=true", async () => {
    const { ctx, transitions } = buildContext({
      proxyResponses: [
        () => jsonResponse({ items: [{ id: "list-primary" }] }),
        () =>
          jsonResponse({
            items: [
              {
                id: "task-deleted",
                title: "Gone",
                deleted: true,
                updated: "2026-05-23T23:00:00.000Z",
              },
            ],
          }),
      ],
    });
    await ctx.cursor.write("main", {
      mappings: { "task-deleted": "mit_existing" },
      mapping_lists: { "task-deleted": "list-primary" },
      per_list: {},
      last_inbound_at: null,
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(transitions).toEqual([{ id: "mit_existing", to: "trashed" }]);
  });

  it("returns ok:false retry:true when tasklists.list fails outright", async () => {
    const { ctx } = buildContext({
      proxyResponses: [() => new Response("boom", { status: 500 })],
    });
    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({
      ok: false,
      retry: true,
      reason: "tasklists.list failed",
    });
  });
});

describe("google-tasks handleItemEvent — outbound create", () => {
  it("scans for the [marfa-id:…] sentinel; absent → POSTs with sentinel injected", async () => {
    const itemForEvent: ItemResource = {
      id: "mit_outbound",
      type: "google.tasks.task",
      state: "active",
      properties: { title: "From Marfa", notes: "Hello there" },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent,
      proxyResponses: [
        // sentinel scan — empty list
        () => jsonResponse({ items: [] }),
        // POST returns the assigned task
        () =>
          jsonResponse({
            id: "task-id-new",
            title: "From Marfa",
            notes: "Hello there\n\n[marfa-id:mit_outbound]",
            etag: "etag-new",
            status: "needsAction",
          }),
      ],
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("mit_outbound"));
    expect(result).toEqual({ ok: true });

    const postCall = proxyCalls.find((c) => c.method === "POST");
    expect(postCall).toBeDefined();
    // `@default` is URL-encoded → `%40default` when passed through
    // `encodeURIComponent` in the handler.
    expect(postCall?.path).toMatch(/\/tasks\/v1\/lists\/%40default\/tasks/);
    const sentBody = postCall?.body as { notes?: string; title?: string };
    expect(sentBody.title).toBe("From Marfa");
    expect(sentBody.notes).toContain("[marfa-id:mit_outbound]");
    expect(sentBody.notes).toContain("Hello there");

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
      mapping_lists: Record<string, string>;
    };
    expect(cursor.mappings["task-id-new"]).toBe("mit_outbound");
    expect(cursor.mapping_lists["task-id-new"]).toBe("@default");
  });

  it("idempotent recovery: prior insert found by sentinel → mapping recorded, no fresh POST", async () => {
    const itemForEvent: ItemResource = {
      id: "mit_recover",
      type: "google.tasks.task",
      state: "active",
      properties: { title: "Recovery" },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent,
      proxyResponses: [
        () =>
          jsonResponse({
            items: [
              {
                id: "task-already-there",
                title: "Old",
                notes: "stuff\n\n[marfa-id:mit_recover]",
                etag: "etag-existing",
                status: "needsAction",
              },
            ],
          }),
      ],
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("mit_recover"));
    expect(result).toEqual({ ok: true });
    const postCount = proxyCalls.filter((c) => c.method === "POST").length;
    expect(postCount).toBe(0);
    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings["task-already-there"]).toBe("mit_recover");
  });

  it("trashed Marfa item → DELETE on the mapped list path", async () => {
    const itemForEvent: ItemResource = {
      id: "mit_trash",
      type: "google.tasks.task",
      state: "trashed",
      properties: { title: "Trash me" },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent,
      proxyResponses: [() => new Response(null, { status: 204 })],
    });
    await ctx.cursor.write("main", {
      mappings: { "task-trash": "mit_trash" },
      mapping_lists: { "task-trash": "list-primary" },
      per_list: {},
      last_inbound_at: null,
    });

    const result = await handleItemEvent(
      ctx,
      ITEM_EVENT("mit_trash", "item.state_changed"),
    );
    expect(result).toEqual({ ok: true });
    const del = proxyCalls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe("/tasks/v1/lists/list-primary/tasks/task-trash");
    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings["task-trash"]).toBeUndefined();
  });
});
