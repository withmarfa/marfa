/**
 * Handler-level tests for the Todoist bidirectional integration.
 *
 * Builds ConnectionContext inline. Mocks ctx.myme entirely (no real
 * HTTP). Tests cover:
 *   - Inbound: Sync API first-run response → todoist.task upsert +
 *     sync_token advance + mapping record.
 *   - Inbound: subsequent run uses persisted sync_token (incremental).
 *   - Inbound: is_deleted / checked items trash the mapped Myme item.
 *   - Inbound: echo-suppressed item skipped, counted in summary.
 *   - Outbound: trashed item → REST /tasks/{id}/close + mapping clear.
 *   - Outbound: update path → REST POST /tasks/{id} body subset.
 *   - Outbound: create path → Sync item_add with deterministic
 *     temp_id + uuid; mapping recorded from temp_id_mapping.
 *   - Outbound: lag-window deferral → ok=false retry=true.
 *   - Outbound: 5xx upstream → retry=true on update.
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
} from "@mymehq/runtime-sdk";
import { handleSchedule, handleItemEvent, __internals } from "./handlers.js";

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

interface FormCall {
  method: string;
  path: string;
  formFields: Record<string, string>;
}

interface JsonCall {
  method: string;
  path: string;
  body: unknown;
}

interface BuildOpts {
  /** ctx.myme.getItem(connection_id) returns this. */
  connectionRecord?: Partial<ItemResource>;
  /** ctx.myme.getItem(otherId) returns this. */
  itemForEvent?: ItemResource | null;
  /** Sequenced proxyRequestForm responses (form-encoded). */
  proxyFormResponses?: (() => Response)[];
  /** Sequenced proxyRequest responses (JSON-bodied). */
  proxyJsonResponses?: (() => Response)[];
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  transitions: { id: string; to: ItemState }[];
  formCalls: FormCall[];
  jsonCalls: JsonCall[];
}

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const transitions: { id: string; to: ItemState }[] = [];
  const formCalls: FormCall[] = [];
  const jsonCalls: JsonCall[] = [];
  let formIdx = 0;
  let jsonIdx = 0;
  const connectionId = "conn_todoist_test";

  const client = {
    createItem: (input: CreateItemInput) => {
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      created.push(input);
      return Promise.resolve({
        id: `mit_${String(created.length)}`,
        type: input.type,
      });
    },
    updateItem: (id: string, patch: Partial<CreateItemInput>) => {
      updated.push({ id, patch });
      return Promise.resolve({ id, type: "todoist.task" });
    },
    getItem: (id: string) => {
      if (id === connectionId) {
        return Promise.resolve(opts.connectionRecord ?? null);
      }
      return Promise.resolve(opts.itemForEvent ?? null);
    },
    transitionItem: (id: string, to: ItemState) => {
      transitions.push({ id, to });
      return Promise.resolve({ id, type: "todoist.task", state: to });
    },
    proxyRequest: (method: string, path: string, body?: unknown) => {
      jsonCalls.push({ method, path, body });
      const responder = opts.proxyJsonResponses?.[jsonIdx];
      jsonIdx += 1;
      if (!responder) {
        return Promise.resolve(
          new Response("no json responder", { status: 500 }),
        );
      }
      return Promise.resolve(responder());
    },
    proxyRequestForm: (
      method: string,
      path: string,
      formFields: Record<string, string>,
    ) => {
      formCalls.push({ method, path, formFields });
      const responder = opts.proxyFormResponses?.[formIdx];
      formIdx += 1;
      if (!responder) {
        return Promise.resolve(
          new Response("no form responder", { status: 500 }),
        );
      }
      return Promise.resolve(responder());
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "todoist.tasks",
    myme: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, {
      echo_ttl_seconds: 120,
      lag_window_seconds: 600,
    }),
    cycle: null,
  };
  return { ctx, emitted, created, updated, transitions, formCalls, jsonCalls };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "todoist.tasks",
  connection_id: "conn_todoist_test",
  scheduled_for_ms: Date.now(),
});

const ITEM_EVENT = (
  itemId: string,
  origin = "conn_other",
): ItemEventMessage => ({
  kind: "item-event",
  integration_name: "todoist.tasks",
  connection_id: "conn_todoist_test",
  event_type: "updated",
  item_id: itemId,
  cycle: { originating_connection_id: origin, hop_count: 1 },
  payload: {},
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const SAMPLE_INBOUND = {
  sync_token: "sync_after_first_pull",
  full_sync: true,
  items: [
    {
      id: "td_1001",
      content: "Buy groceries",
      description: "Apples + bread",
      project_id: "proj_inbox",
      priority: 2,
      labels: ["home"],
      due: { date: "2026-05-25" },
      checked: false,
      is_deleted: false,
      url: "https://todoist.com/showTask?id=1001",
      comment_count: 0,
    },
    {
      id: "td_1002",
      content: "Email the architect",
      project_id: "proj_house",
      priority: 4,
      labels: [],
      checked: false,
      is_deleted: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Inbound — schedule handler
// ---------------------------------------------------------------------------

describe("Todoist handlers — inbound (schedule)", () => {
  it("upserts items on first run, advances sync_token, records mappings", async () => {
    const { ctx, created, formCalls, emitted } = buildContext({
      proxyFormResponses: [() => jsonResponse(SAMPLE_INBOUND)],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      type: "todoist.task",
      source_id: "td_1001",
    });
    expect(created[0]!.properties).toMatchObject({
      title: "Buy groceries",
      description: "Apples + bread",
      project_id: "proj_inbox",
      priority: 2,
      labels: ["home"],
    });
    expect(formCalls[0]!.method).toBe("POST");
    expect(formCalls[0]!.path).toBe("/api/v1/sync");
    expect(formCalls[0]!.formFields.sync_token).toBe("*");
    expect(formCalls[0]!.formFields.resource_types).toBe(
      JSON.stringify(["items"]),
    );

    const cursor = (await ctx.cursor.read("main")) as {
      sync_token: string;
      mappings: Record<string, string>;
    };
    expect(cursor.sync_token).toBe("sync_after_first_pull");
    expect(cursor.mappings.td_1001).toBe("mit_1");
    expect(cursor.mappings.td_1002).toBe("mit_2");
    expect(emitted.at(-1)?.properties?.summary).toMatch(/upserted=2/);
  });

  it("uses the persisted sync_token on subsequent runs (incremental)", async () => {
    const { ctx, formCalls } = buildContext({
      proxyFormResponses: [
        () => jsonResponse(SAMPLE_INBOUND),
        () => jsonResponse({ sync_token: "sync_2", items: [] }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(formCalls[1]!.formFields.sync_token).toBe("sync_after_first_pull");
  });

  it("trashes the mapped Myme item when Todoist marks the task is_deleted", async () => {
    const { ctx, transitions } = buildContext({
      proxyFormResponses: [
        () => jsonResponse(SAMPLE_INBOUND),
        () =>
          jsonResponse({
            sync_token: "sync_2",
            items: [{ id: "td_1001", is_deleted: true }],
          }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(transitions).toEqual([{ id: "mit_1", to: "trashed" }]);
  });

  it("trashes the mapped Myme item when Todoist marks the task checked (completed)", async () => {
    const { ctx, transitions } = buildContext({
      proxyFormResponses: [
        () => jsonResponse(SAMPLE_INBOUND),
        () =>
          jsonResponse({
            sync_token: "sync_2",
            items: [{ id: "td_1002", checked: true }],
          }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(transitions).toEqual([{ id: "mit_2", to: "trashed" }]);
  });

  it("strips the [myme-id:...] sentinel from description on inbound", async () => {
    const { ctx, created } = buildContext({
      proxyFormResponses: [
        () =>
          jsonResponse({
            sync_token: "s",
            items: [
              {
                id: "td_with_sentinel",
                content: "Task we created from Myme",
                description: "My real notes\n\n[myme-id:itm_alpha]",
              },
            ],
          }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(created[0]!.properties?.description).toBe("My real notes");
  });
});

// ---------------------------------------------------------------------------
// Outbound — item-event handler
// ---------------------------------------------------------------------------

const MYME_TASK = (
  id: string,
  overrides: Partial<{
    title: string;
    description: string;
    priority: number;
    labels: string[];
    state: ItemState;
  }> = {},
): ItemResource => ({
  id,
  type: "todoist.task",
  state: overrides.state ?? "active",
  properties: {
    title: overrides.title ?? "New Myme task",
    ...(overrides.description !== undefined
      ? { description: overrides.description }
      : {}),
    ...(overrides.priority !== undefined
      ? { priority: overrides.priority }
      : {}),
    ...(overrides.labels !== undefined ? { labels: overrides.labels } : {}),
  },
});

describe("Todoist handlers — outbound (item-event)", () => {
  it("creates a Todoist task via Sync API item_add with deterministic temp_id + uuid", async () => {
    const item = MYME_TASK("itm_alpha", {
      title: "Send the contract",
      description: "Notes about the contract",
      priority: 3,
      labels: ["work"],
    });
    const expectedTempId = await __internals.deriveTempId("itm_alpha");
    const expectedUuid = await __internals.deriveCommandUuid("itm_alpha");

    const { ctx, formCalls } = buildContext({
      itemForEvent: item,
      proxyFormResponses: [
        () =>
          jsonResponse({
            sync_token: "sync_post_add",
            sync_status: { [expectedUuid]: "ok" },
            temp_id_mapping: { [expectedTempId]: "td_9001" },
          }),
      ],
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("itm_alpha"));
    expect(result).toEqual({ ok: true });
    expect(formCalls).toHaveLength(1);
    expect(formCalls[0]!.path).toBe("/api/v1/sync");
    const commands = JSON.parse(formCalls[0]!.formFields.commands ?? "[]") as {
      type: string;
      temp_id: string;
      uuid: string;
      args: { content: string; description?: string; priority?: number };
    }[];
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "item_add",
      temp_id: expectedTempId,
      uuid: expectedUuid,
    });
    expect(commands[0]!.args.content).toBe("Send the contract");
    expect(commands[0]!.args.description).toMatch(/Notes about the contract/);
    expect(commands[0]!.args.description).toMatch(/\[myme-id:itm_alpha\]/);
    expect(commands[0]!.args.priority).toBe(3);

    const cursor = (await ctx.cursor.read("main")) as {
      sync_token: string;
      mappings: Record<string, string>;
    };
    expect(cursor.sync_token).toBe("sync_post_add");
    expect(cursor.mappings.td_9001).toBe("itm_alpha");
  });

  it("retrying with the same Myme item id reproduces the same temp_id + uuid (T-020 idempotency rail)", async () => {
    const first = await __internals.deriveTempId("itm_idem");
    const second = await __internals.deriveTempId("itm_idem");
    const firstUuid = await __internals.deriveCommandUuid("itm_idem");
    const secondUuid = await __internals.deriveCommandUuid("itm_idem");
    expect(first).toBe(second);
    expect(firstUuid).toBe(secondUuid);
    // Distinct seeds → distinct hashes.
    expect(first).not.toBe(firstUuid);
  });

  it("updates an existing mapped task via REST POST /api/v1/tasks/{id}", async () => {
    const item = MYME_TASK("itm_beta", { title: "Updated title", priority: 4 });
    const { ctx, jsonCalls } = buildContext({
      itemForEvent: item,
      proxyJsonResponses: [
        () =>
          jsonResponse({
            id: "td_4242",
            content: "Updated title",
            priority: 4,
          }),
      ],
    });
    // Pre-seed the cursor with a mapping.
    await ctx.cursor.write("main", {
      sync_token: "*",
      last_inbound_at: null,
      mappings: { td_4242: "itm_beta" },
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("itm_beta"));
    expect(result).toEqual({ ok: true });
    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/tasks/td_4242",
    });
    expect(jsonCalls[0]!.body).toMatchObject({
      content: "Updated title",
      priority: 4,
    });
  });

  it("trashing a Myme task closes the upstream Todoist task and clears the mapping", async () => {
    const item: ItemResource = {
      id: "itm_gamma",
      type: "todoist.task",
      state: "trashed",
      properties: { title: "Doomed" },
    };
    const { ctx, jsonCalls } = buildContext({
      itemForEvent: item,
      proxyJsonResponses: [() => new Response("", { status: 200 })],
    });
    await ctx.cursor.write("main", {
      sync_token: "*",
      last_inbound_at: null,
      mappings: { td_5555: "itm_gamma" },
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("itm_gamma"));
    expect(result).toEqual({ ok: true });
    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/tasks/td_5555/close",
    });
    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings).toEqual({});
  });

  it("defers with retry=true when the external_id is in the lag window", async () => {
    const item = MYME_TASK("itm_delta", { title: "Recently echoed" });
    const { ctx } = buildContext({ itemForEvent: item });
    await ctx.cursor.write("main", {
      sync_token: "*",
      last_inbound_at: null,
      mappings: { td_recent: "itm_delta" },
    });
    // Record an outbound write a moment ago so the id is in the lag window.
    await ctx.echo.trackOutboundWrite("td_recent", "h");

    const result = await handleItemEvent(ctx, ITEM_EVENT("itm_delta"));
    expect(result).toEqual({
      ok: false,
      retry: true,
      reason: "in_lag_window",
    });
  });

  it("returns retry=true on REST 5xx during update", async () => {
    const item = MYME_TASK("itm_epsilon", { title: "Service down" });
    const { ctx } = buildContext({
      itemForEvent: item,
      proxyJsonResponses: [
        () => new Response("upstream broke", { status: 503 }),
      ],
    });
    await ctx.cursor.write("main", {
      sync_token: "*",
      last_inbound_at: null,
      mappings: { td_8888: "itm_epsilon" },
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("itm_epsilon"));
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it("4xx on update surfaces accept-partial (ok=true) with action_required activity", async () => {
    const item = MYME_TASK("itm_zeta", { title: "Bad payload" });
    const { ctx, emitted } = buildContext({
      itemForEvent: item,
      proxyJsonResponses: [
        () =>
          new Response(JSON.stringify({ error: "bad request" }), {
            status: 400,
          }),
      ],
    });
    await ctx.cursor.write("main", {
      sync_token: "*",
      last_inbound_at: null,
      mappings: { td_400: "itm_zeta" },
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("itm_zeta"));
    expect(result).toEqual({ ok: true });
    const last = emitted.at(-1);
    expect(last?.properties?.severity).toBe("action_required");
  });

  it("ignores self-events (cycle's originating_connection_id === ctx.connection_id)", async () => {
    const { ctx, jsonCalls, formCalls } = buildContext({
      itemForEvent: MYME_TASK("itm_self"),
    });
    const result = await handleItemEvent(
      ctx,
      ITEM_EVENT("itm_self", "conn_todoist_test"),
    );
    expect(result).toEqual({ ok: true });
    expect(jsonCalls).toHaveLength(0);
    expect(formCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// __internals — exercised directly for fine-grained coverage
// ---------------------------------------------------------------------------

describe("Todoist internals", () => {
  it("stripSentinel removes the [myme-id:...] line and trims whitespace", () => {
    const stripped = __internals.stripSentinel(
      "Real notes\nMore notes\n\n[myme-id:abc-123]",
    );
    expect(stripped).toBe("Real notes\nMore notes");
  });

  it("appendSentinel adds the sentinel line to a description", () => {
    const out = __internals.appendSentinel("notes", "itm_x");
    expect(out).toBe("notes\n\n[myme-id:itm_x]");
  });

  it("appendSentinel preserves description when input is empty", () => {
    const out = __internals.appendSentinel("", "itm_y");
    expect(out).toBe("[myme-id:itm_y]");
  });

  it("buildItemInput translates a Todoist item into a todoist.task input", () => {
    const input = __internals.buildItemInput({
      id: "td_x",
      content: "Hello",
      description: "World",
      priority: 4,
      labels: ["a", "b"],
      project_id: "proj_x",
      due: { date: "2026-05-25" },
      checked: false,
    });
    expect(input.type).toBe("todoist.task");
    expect(input.properties).toMatchObject({
      title: "Hello",
      description: "World",
      priority: 4,
      labels: ["a", "b"],
      project_id: "proj_x",
      due: { date: "2026-05-25" },
      completed: false,
    });
  });
});
