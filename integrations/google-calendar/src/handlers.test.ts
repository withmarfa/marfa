/**
 * Handler-level tests for the Google Calendar bidirectional integration.
 *
 * Builds ConnectionContext inline. Mocks ctx.marfa entirely (no
 * real HTTP). Tests cover:
 *   - Inbound: events.list response → core.event upsert + cursor advance
 *   - Inbound: cancelled event → trashed transition on the mapped Marfa item
 *   - Inbound: echo-suppressed event → no upsert, counted as skipped
 *   - Inbound: 410 syncToken invalidation → cursor reset
 *   - Outbound: created core.event → POST to Calendar + mapping recorded
 *   - Outbound: updated core.event with mapping → PATCH
 *   - Outbound: trashed core.event with mapping → DELETE
 *   - Outbound: lag-window deferral → ok=false retry=true
 *   - Outbound: 5xx upstream → retry=true
 *   - Outbound: 4xx upstream → ack (accept-partial)
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
} from "@withmarfa/runtime-sdk";
import { handleSchedule, handleItemEvent } from "./handlers.js";

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
  /** ctx.marfa.getItem(connection_id) returns this. */
  connectionRecord?: Partial<ItemResource>;
  /** ctx.marfa.getItem(otherId) returns this when called for an
   *  item-event handler. */
  itemForEvent?: ItemResource | null;
  /** Sequenced proxy responses (in call order). */
  proxyResponses: (() => Response)[];
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  transitions: { id: string; to: ItemState }[];
  proxyCalls: ProxyCall[];
}

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const transitions: { id: string; to: ItemState }[] = [];
  const proxyCalls: ProxyCall[] = [];
  let proxyIdx = 0;
  const connectionId = "conn_gcal_test";

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
      return Promise.resolve({ id, type: "core.event" });
    },
    getItem: (id: string) => {
      if (id === connectionId) {
        return Promise.resolve(opts.connectionRecord ?? null);
      }
      return Promise.resolve(opts.itemForEvent ?? null);
    },
    transitionItem: (id: string, to: ItemState) => {
      transitions.push({ id, to });
      return Promise.resolve({ id, type: "core.event", state: to });
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
    connection_id: connectionId,
    integration_name: "google.calendar",
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, {
      echo_ttl_seconds: 120,
      lag_window_seconds: 600,
    }),
    cycle: null,
  };
  return {
    ctx,
    emitted,
    created,
    updated,
    transitions,
    proxyCalls,
  };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "google.calendar",
  connection_id: "conn_gcal_test",
  scheduled_for_ms: Date.now(),
});

const ITEM_EVENT = (
  itemId: string,
  eventType = "updated",
  origin = "conn_other",
): ItemEventMessage => ({
  kind: "item-event",
  integration_name: "google.calendar",
  connection_id: "conn_gcal_test",
  event_type: eventType,
  item_id: itemId,
  cycle: { originating_connection_id: origin, hop_count: 1 },
  payload: {},
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SAMPLE_INBOUND = {
  items: [
    {
      id: "gevt_1",
      etag: "etag_1",
      summary: "Example Event 1",
      description: "First example",
      location: "Office",
      htmlLink: "https://calendar.google.com/event?eid=gevt_1",
      start: { dateTime: "2026-04-29T13:00:00Z" },
      end: { dateTime: "2026-04-29T16:00:00Z" },
      status: "confirmed",
    },
    {
      id: "gevt_2",
      etag: "etag_2",
      summary: "Example Event 2",
      start: { dateTime: "2026-05-02T11:00:00Z" },
      end: { dateTime: "2026-05-02T14:00:00Z" },
      status: "confirmed",
    },
  ],
  nextSyncToken: "sync_after_first_pull",
};

describe("Google Calendar handlers — inbound (schedule)", () => {
  it("upserts events on first run, advances syncToken, records mappings", async () => {
    const { ctx, created, proxyCalls, emitted } = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_INBOUND)],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(2);
    expect(created[0]!.properties).toMatchObject({
      title: "Example Event 1",
      starts_at: "2026-04-29T13:00:00Z",
      ends_at: "2026-04-29T16:00:00Z",
      place: "Office",
    });
    expect(proxyCalls[0]!.method).toBe("GET");
    expect(proxyCalls[0]!.path).toMatch(/maxResults=250/);

    const cursor = (await ctx.cursor.read("main")) as {
      syncToken: string;
      mappings: Record<string, string>;
    };
    expect(cursor.syncToken).toBe("sync_after_first_pull");
    expect(cursor.mappings.gevt_1).toBe("mit_1");
    expect(cursor.mappings.gevt_2).toBe("mit_2");

    expect(emitted.at(-1)?.properties?.summary).toMatch(/upserted=2/);
  });

  it("uses syncToken on subsequent runs (incremental sync)", async () => {
    const { ctx, proxyCalls } = buildContext({
      proxyResponses: [
        () => jsonResponse(SAMPLE_INBOUND),
        () => jsonResponse({ items: [], nextSyncToken: "sync_2" }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(proxyCalls[1]!.path).toMatch(/syncToken=sync_after_first_pull/);
  });

  it("trashes the matching Marfa item when Calendar marks the event cancelled", async () => {
    const { ctx, transitions } = buildContext({
      proxyResponses: [
        () => jsonResponse(SAMPLE_INBOUND),
        () =>
          jsonResponse({
            items: [{ id: "gevt_1", status: "cancelled" }],
            nextSyncToken: "sync_2",
          }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(transitions).toEqual([{ id: "mit_1", to: "trashed" }]);
  });

  it("re-bootstraps after a 410 invalid syncToken response", async () => {
    const { ctx, emitted } = buildContext({
      proxyResponses: [() => new Response("Gone", { status: 410 })],
    });
    // Pre-seed cursor with a stale syncToken.
    await ctx.cursor.write("main", {
      syncToken: "stale",
      last_inbound_at: null,
      mappings: {},
    });
    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    const cursor = (await ctx.cursor.read("main")) as {
      syncToken: string | null;
    };
    expect(cursor.syncToken).toBeNull();
    expect(emitted.at(-1)?.properties?.summary).toMatch(
      /syncToken invalidated/,
    );
  });

  it("skips events whose hash matches a recent outbound (echo suppression)", async () => {
    const { ctx, created, emitted } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            items: [
              {
                id: "gevt_3",
                etag: "etag_3",
                summary: "Recently created from Marfa",
                start: { dateTime: "2026-05-06T18:00:00Z" },
                end: { dateTime: "2026-05-06T21:00:00Z" },
              },
            ],
            nextSyncToken: "sync_after",
          }),
      ],
    });
    // Record an outbound write of this same id+hash a moment ago.
    await ctx.echo.trackOutboundWrite("gevt_3", "etag_3");

    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(created).toHaveLength(0);
    expect(emitted.at(-1)?.properties?.summary).toMatch(/echo_skipped=1/);
  });
});

describe("Google Calendar handlers — outbound (item-event)", () => {
  it("POSTs a new Calendar event for an item with no mapping", async () => {
    const item: ItemResource = {
      id: "mit_new",
      type: "core.event",
      state: "active",
      properties: {
        title: "New Marfa event",
        starts_at: "2026-06-01T10:00:00Z",
        ends_at: "2026-06-01T11:00:00Z",
      },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent: item,
      proxyResponses: [
        () => jsonResponse({ id: "gevt_new", etag: "etag_new" }, 201),
      ],
    });

    const r = await handleItemEvent(ctx, ITEM_EVENT("mit_new", "created"));
    expect(r).toEqual({ ok: true });
    expect(proxyCalls[0]!.method).toBe("POST");
    expect(proxyCalls[0]!.path).toMatch(/calendars\/primary\/events$/);
    // T-020: a deterministic id is stamped onto the POST payload
    // so a retry of the same handler invocation reaches Calendar
    // with the same id (Calendar then 409s instead of duplicating).
    const sentBody = proxyCalls[0]!.body as { id?: string };
    expect(typeof sentBody.id).toBe("string");
    expect(sentBody.id).toMatch(/^[0-9a-f]{64}$/);

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings.gevt_new).toBe("mit_new");
  });

  it("recovers idempotently when Calendar 409s on a retried POST (T-020)", async () => {
    // Cloudflare Queues retries the whole batch when the handler
    // doesn't ack cleanly. If the original attempt POSTed
    // successfully but crashed before the cursor write persisted,
    // the retry sees no mapping and re-POSTs. Without the T-020
    // deterministic-id fix, the retry would create a duplicate
    // Calendar event. With the fix, Calendar 409s on the duplicate
    // id and the handler GET-s the event Calendar already holds,
    // records the mapping, and returns ok=true — no duplicate.
    const item: ItemResource = {
      id: "mit_retry",
      type: "core.event",
      state: "active",
      properties: {
        title: "Retried event",
        starts_at: "2026-06-02T10:00:00Z",
        ends_at: "2026-06-02T11:00:00Z",
      },
    };
    const { ctx, proxyCalls, emitted } = buildContext({
      itemForEvent: item,
      proxyResponses: [
        // Retry's POST: Calendar already has it from the prior attempt.
        () => new Response("conflict", { status: 409 }),
        // Handler's recovery GET: Calendar returns the event's
        // current state so we can record the mapping + lag-window.
        () =>
          jsonResponse({
            id: "EXPECTED-DETERMINISTIC-ID",
            etag: "etag_calendar_v1",
            summary: "Retried event",
            start: { dateTime: "2026-06-02T10:00:00Z" },
            end: { dateTime: "2026-06-02T11:00:00Z" },
            status: "confirmed",
          }),
      ],
    });

    const r = await handleItemEvent(ctx, ITEM_EVENT("mit_retry", "created"));
    expect(r).toEqual({ ok: true });

    // First call is the POST that 409s, second is the recovery GET.
    expect(proxyCalls).toHaveLength(2);
    expect(proxyCalls[0]!.method).toBe("POST");
    expect(proxyCalls[1]!.method).toBe("GET");
    // Both calls target the same deterministic id — the handler must
    // GET the exact id it sent, otherwise the recovery is unsound.
    const sentId = (proxyCalls[0]!.body as { id?: string }).id;
    expect(sentId).toMatch(/^[0-9a-f]{64}$/);
    expect(proxyCalls[1]!.path).toContain(encodeURIComponent(sentId!));

    // Mapping recorded against the deterministic id, not against
    // whatever id the GET response carried — the contract is "we
    // sent it, we own it". We assert against the sent id so a
    // future Calendar response shape change can't regress this.
    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings[sentId!]).toBe("mit_retry");

    // Operator-visible "we recovered" trail.
    expect(emitted.at(-1)?.properties?.summary).toMatch(/idempotent recovery/);
  });

  it("derives the same deterministic id across retries (T-020)", async () => {
    // Sanity check: two invocations for the same Marfa item id MUST
    // stamp the same Calendar id, otherwise the 409 idempotency
    // path can't fire.
    const item: ItemResource = {
      id: "mit_stable",
      type: "core.event",
      state: "active",
      properties: { title: "Stable" },
    };
    const sentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { ctx, proxyCalls } = buildContext({
        itemForEvent: item,
        proxyResponses: [
          () => jsonResponse({ id: "gevt_x", etag: "etag_x" }, 201),
        ],
      });
      await handleItemEvent(ctx, ITEM_EVENT("mit_stable", "created"));
      const body = proxyCalls[0]!.body as { id?: string };
      sentIds.push(body.id ?? "");
    }
    expect(sentIds[0]).toBe(sentIds[1]);
    expect(sentIds[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PATCHes a mapped Calendar event on update", async () => {
    const item: ItemResource = {
      id: "mit_existing",
      type: "core.event",
      state: "active",
      properties: { title: "Updated title" },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent: item,
      proxyResponses: [
        () => jsonResponse({ id: "gevt_existing", etag: "etag_v2" }),
      ],
    });
    await ctx.cursor.write("main", {
      syncToken: null,
      last_inbound_at: null,
      mappings: { gevt_existing: "mit_existing" },
    });

    await handleItemEvent(ctx, ITEM_EVENT("mit_existing", "updated"));
    expect(proxyCalls[0]!.method).toBe("PATCH");
    expect(proxyCalls[0]!.path).toMatch(/events\/gevt_existing$/);
  });

  it("DELETEs the mapped Calendar event when the Marfa item is trashed", async () => {
    const item: ItemResource = {
      id: "mit_trashed",
      type: "core.event",
      state: "trashed",
      properties: {},
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent: item,
      proxyResponses: [() => new Response(null, { status: 204 })],
    });
    await ctx.cursor.write("main", {
      syncToken: null,
      last_inbound_at: null,
      mappings: { gevt_trashed: "mit_trashed" },
    });

    await handleItemEvent(ctx, ITEM_EVENT("mit_trashed", "state_changed"));
    expect(proxyCalls[0]!.method).toBe("DELETE");
    expect(proxyCalls[0]!.path).toMatch(/events\/gevt_trashed$/);

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings.gevt_trashed).toBeUndefined();
  });

  it("defers when the same external_id is in the lag window", async () => {
    const item: ItemResource = {
      id: "mit_lag",
      type: "core.event",
      state: "active",
      properties: { title: "X" },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent: item,
      proxyResponses: [],
    });
    await ctx.cursor.write("main", {
      syncToken: null,
      last_inbound_at: null,
      mappings: { gevt_lag: "mit_lag" },
    });
    // Recent outbound to this id puts it in the lag window.
    await ctx.echo.trackOutboundWrite("gevt_lag", "h1");

    const r = await handleItemEvent(ctx, ITEM_EVENT("mit_lag"));
    expect(r).toEqual({ ok: false, retry: true, reason: "in_lag_window" });
    expect(proxyCalls).toHaveLength(0);
  });

  it("retries on Calendar 5xx response", async () => {
    const item: ItemResource = {
      id: "mit_5xx",
      type: "core.event",
      state: "active",
      properties: { title: "X" },
    };
    const { ctx, emitted } = buildContext({
      itemForEvent: item,
      proxyResponses: [() => new Response("Server error", { status: 503 })],
    });
    const r = await handleItemEvent(ctx, ITEM_EVENT("mit_5xx", "created"));
    expect(r).toMatchObject({ ok: false, retry: true });
    expect(
      emitted.some((e) => e.properties?.severity === "action_required"),
    ).toBe(true);
  });

  it("acks (accept-partial) on Calendar 4xx response", async () => {
    const item: ItemResource = {
      id: "mit_4xx",
      type: "core.event",
      state: "active",
      properties: { title: "Bad payload" },
    };
    const { ctx, emitted } = buildContext({
      itemForEvent: item,
      proxyResponses: [() => new Response("Bad request", { status: 400 })],
    });
    const r = await handleItemEvent(ctx, ITEM_EVENT("mit_4xx", "created"));
    expect(r).toEqual({ ok: true });
    const required = emitted.filter(
      (e) => e.properties?.severity === "action_required",
    );
    expect(required).toHaveLength(1);
  });

  it("ignores self-originated item events (defensive)", async () => {
    const { ctx, proxyCalls } = buildContext({
      itemForEvent: null,
      proxyResponses: [],
    });
    const r = await handleItemEvent(
      ctx,
      ITEM_EVENT("mit_self", "updated", "conn_gcal_test"),
    );
    expect(r).toEqual({ ok: true });
    expect(proxyCalls).toHaveLength(0);
  });
});
