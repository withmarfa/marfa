/**
 * Handler-level tests for the Google Calendar bidirectional integration.
 *
 * Builds ConnectionContext inline. Mocks ctx.marfa entirely (no
 * real HTTP). Tests cover:
 *   - Inbound: events.list response → target-type upsert + cursor advance
 *   - Inbound: multi-page response → every page ingested, sync token stored
 *   - Inbound: sweep past the page brake parks and resumes a page token
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
import { GOOGLE_CALENDAR_MANIFEST } from "./manifest.js";
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
import {
  handleSchedule,
  handleItemEvent,
  MAX_PAGES_PER_SWEEP,
} from "./handlers.js";

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
  edges: { source_id: string; target_id: string; edge_type: string }[];
}

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const transitions: { id: string; to: ItemState }[] = [];
  const proxyCalls: ProxyCall[] = [];
  const edges: { source_id: string; target_id: string; edge_type: string }[] =
    [];
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
    ensureEdge: (input: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }) => {
      edges.push(input);
      return Promise.resolve("created" as const);
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
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return {
    ctx,
    emitted,
    created,
    updated,
    transitions,
    proxyCalls,
    edges,
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

/** Minimal confirmed event — enough for the ingest path to upsert it. */
function pageEvent(id: string): Record<string, unknown> {
  return {
    id,
    etag: `etag_${id}`,
    summary: `Event ${id}`,
    start: { dateTime: "2026-04-29T13:00:00Z" },
    end: { dateTime: "2026-04-29T14:00:00Z" },
    status: "confirmed",
  };
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

describe("Google Calendar handlers — the type a connection writes", () => {
  // The type a connection writes is the most consequential thing about its
  // corpus, and it used to be decided by which branch ran. A connection with
  // no selection wrote core.event; the moment the picker saved one, the same
  // connection wrote google.calendar.event, leaving one logical corpus split
  // across two types with no way back.
  it("writes the manifest's declared type when nothing is configured", async () => {
    const { ctx, created } = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_INBOUND)],
      connectionRecord: {
        id: "conn_gcal_test",
        type: "system.connection",
        properties: { kind: "integration", configuration: {} },
      },
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(created).toHaveLength(2);
    expect(created.every((c) => c.type === "google.calendar.event")).toBe(true);
    expect(
      GOOGLE_CALENDAR_MANIFEST.configuration_schema?.write_family?.default,
    ).toBe("google");
  });

  it("writes the configured family's type when the install names one", async () => {
    const { ctx, created } = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_INBOUND)],
      connectionRecord: {
        id: "conn_gcal_test",
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: { write_family: "core" },
        },
      },
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(created).toHaveLength(2);
    expect(created.every((c) => c.type === "core.event")).toBe(true);
  });

  it("honors a legacy stored target_type by resolving its family", async () => {
    // Pins the legacy stored-configuration read: connections configured
    // before write families carry `target_type` rather than
    // `write_family`, and that value must keep deciding what they write
    // until the post-cutover configuration rewrite removes it.
    const { ctx, created } = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_INBOUND)],
      connectionRecord: {
        id: "conn_gcal_test",
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: { target_type: "core.event" },
        },
      },
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(created).toHaveLength(2);
    expect(created.every((c) => c.type === "core.event")).toBe(true);
  });

  it("does not change type when a connection gains a calendar selection", async () => {
    // The same connection, before and after the picker saves. This is the
    // transition that used to flip the type under an existing corpus.
    const withoutSelection = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_INBOUND)],
      connectionRecord: {
        id: "conn_gcal_test",
        type: "system.connection",
        properties: { kind: "integration", configuration: {} },
      },
    });
    await handleSchedule(withoutSelection.ctx, SCHEDULE_MSG());

    const withSelection = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_INBOUND)],
      connectionRecord: {
        id: "conn_gcal_test",
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: { selected_calendar_ids: ["primary"] },
        },
      },
    });
    await handleSchedule(withSelection.ctx, SCHEDULE_MSG());

    expect(withoutSelection.created.map((c) => c.type)).toEqual(
      withSelection.created.map((c) => c.type),
    );
  });
});

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

  it("follows nextPageToken to the last page and stores the sync token it carries", async () => {
    // Calendar returns `nextSyncToken` only on the final page of a
    // result set. A sweep that reads page one and stops never receives
    // a token, so the cursor never advances and every subsequent tick
    // refetches the same first page — a silent, permanent stall on any
    // calendar with more changed events than fit in one page.
    const { ctx, created, proxyCalls } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            items: [pageEvent("gevt_p1a"), pageEvent("gevt_p1b")],
            nextPageToken: "tok_page_2",
          }),
        () =>
          jsonResponse({
            items: [pageEvent("gevt_p2a")],
            nextPageToken: "tok_page_3",
          }),
        () =>
          jsonResponse({
            items: [pageEvent("gevt_p3a")],
            nextSyncToken: "sync_after_last_page",
          }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    expect(proxyCalls).toHaveLength(3);
    expect(proxyCalls[0]!.path).toMatch(/maxResults=250/);
    expect(proxyCalls[0]!.path).not.toMatch(/pageToken/);
    expect(proxyCalls[1]!.path).toMatch(/pageToken=tok_page_2/);
    expect(proxyCalls[2]!.path).toMatch(/pageToken=tok_page_3/);

    // Every page's events are ingested, not just the first page's.
    expect(created).toHaveLength(4);

    const cursor = (await ctx.cursor.read("main")) as {
      syncToken: string | null;
      mappings: Record<string, string>;
    };
    expect(cursor.syncToken).toBe("sync_after_last_page");
    expect(Object.keys(cursor.mappings).sort()).toEqual([
      "gevt_p1a",
      "gevt_p1b",
      "gevt_p2a",
      "gevt_p3a",
    ]);
  });

  it("sends the stored sync token on the tick after a paginated sweep", async () => {
    // The stall this guards against is observable one tick later: with
    // no token stored, the follow-up request reissues the untokened
    // first-page query instead of asking for what changed since.
    const { ctx, proxyCalls } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            items: [pageEvent("gevt_a")],
            nextPageToken: "tok_page_2",
          }),
        () =>
          jsonResponse({
            items: [pageEvent("gevt_b")],
            nextSyncToken: "sync_paginated",
          }),
        () => jsonResponse({ items: [], nextSyncToken: "sync_paginated_2" }),
      ],
    });

    await handleSchedule(ctx, SCHEDULE_MSG());
    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(proxyCalls).toHaveLength(3);
    expect(proxyCalls[2]!.path).toMatch(/syncToken=sync_paginated/);
    expect(proxyCalls[2]!.path).not.toMatch(/pageToken/);
  });

  it("parks the next page token when a sweep exceeds the per-run page brake", async () => {
    // A backfill larger than one invocation's budget stops at the brake.
    // Parking the page token is what keeps that from becoming the same
    // stall by another name: the next tick resumes mid-sweep rather than
    // restarting at page one.
    const { ctx, created, proxyCalls } = buildContext({
      proxyResponses: Array.from(
        { length: MAX_PAGES_PER_SWEEP + 1 },
        (_, i) => () =>
          jsonResponse({
            items: [pageEvent(`gevt_brake_${String(i)}`)],
            nextPageToken: `tok_${String(i + 1)}`,
          }),
      ),
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(proxyCalls).toHaveLength(MAX_PAGES_PER_SWEEP);
    expect(created).toHaveLength(MAX_PAGES_PER_SWEEP);

    const cursor = (await ctx.cursor.read("main")) as {
      syncToken: string | null;
      pageToken: string | null;
    };
    expect(cursor.syncToken).toBeNull();
    expect(cursor.pageToken).toBe(`tok_${String(MAX_PAGES_PER_SWEEP)}`);
  });

  it("resumes from the parked page token on the following tick", async () => {
    const { ctx, proxyCalls } = buildContext({
      proxyResponses: [
        () => jsonResponse({ items: [], nextSyncToken: "sync_resumed" }),
      ],
    });
    await ctx.cursor.write("main", {
      syncToken: null,
      pageToken: "tok_parked",
      last_inbound_at: null,
      mappings: {},
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(proxyCalls[0]!.path).toMatch(/pageToken=tok_parked/);
    const cursor = (await ctx.cursor.read("main")) as {
      syncToken: string | null;
      pageToken: string | null;
    };
    expect(cursor.syncToken).toBe("sync_resumed");
    expect(cursor.pageToken).toBeNull();
  });

  it("keeps mappings from pages already ingested when a later page fails", async () => {
    // Without persisting mid-sweep progress, the retry sees no mapping
    // for the events page one already created and makes duplicates.
    const { ctx, created } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            items: [pageEvent("gevt_kept")],
            nextPageToken: "tok_page_2",
          }),
        () => new Response("boom", { status: 503 }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toMatchObject({ ok: false, retry: true });
    expect(created).toHaveLength(1);

    const cursor = (await ctx.cursor.read("main")) as {
      syncToken: string | null;
      mappings: Record<string, string>;
    };
    expect(cursor.mappings.gevt_kept).toBe("mit_1");
    expect(cursor.syncToken).toBeNull();
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
    // A deterministic id is stamped onto the POST payload so a retry
    // of the same handler invocation reaches Calendar with the same
    // id (Calendar then 409s instead of duplicating).
    const sentBody = proxyCalls[0]!.body as { id?: string };
    expect(typeof sentBody.id).toBe("string");
    expect(sentBody.id).toMatch(/^[0-9a-f]{64}$/);

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings.gevt_new).toBe("mit_new");
  });

  it("recovers idempotently when Calendar 409s on a retried POST", async () => {
    // Cloudflare Queues retries the whole batch when the handler
    // doesn't ack cleanly. If the original attempt POSTed
    // successfully but crashed before the cursor write persisted,
    // the retry sees no mapping and re-POSTs. Without a deterministic
    // id, the retry would create a duplicate Calendar event. With it,
    // Calendar 409s on the duplicate id and the handler GET-s the
    // event Calendar already holds, records the mapping, and returns
    // ok=true — no duplicate.
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

  it("derives the same deterministic id across retries", async () => {
    // Sanity check: two invocations for the same item id MUST stamp
    // the same Calendar id, otherwise the 409 idempotency path
    // can't fire.
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

const SERIES_INBOUND = {
  items: [
    {
      id: "gseries_1",
      summary: "Weekly review",
      start: { dateTime: "2026-07-06T10:00:00Z", timeZone: "Europe/Berlin" },
      end: { dateTime: "2026-07-06T11:00:00Z", timeZone: "Europe/Berlin" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      status: "confirmed",
    },
    {
      id: "gseries_1_20260713T100000Z",
      summary: "Weekly review",
      start: { dateTime: "2026-07-13T15:00:00Z", timeZone: "Europe/Berlin" },
      end: { dateTime: "2026-07-13T16:00:00Z", timeZone: "Europe/Berlin" },
      recurringEventId: "gseries_1",
      originalStartTime: { dateTime: "2026-07-13T10:00:00Z" },
      status: "confirmed",
    },
  ],
  nextSyncToken: "sync_series",
};

describe("Google Calendar handlers — recurrence", () => {
  it("carries the rule and its zone onto core.event, not only the fidelity type", async () => {
    const { ctx, created } = buildContext({
      proxyResponses: [() => jsonResponse(SERIES_INBOUND)],
      connectionRecord: {
        id: "conn_gcal_test",
        type: "system.connection",
        properties: { configuration: { write_family: "core" } },
      },
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    const series = created.find((c) => c.source_id === "gseries_1");
    expect(series?.type).toBe("core.event");
    expect(series?.properties).toMatchObject({
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      timezone: "Europe/Berlin",
    });
  });

  it("stamps the occurrence a moved instance replaces", async () => {
    const { ctx, created } = buildContext({
      proxyResponses: [() => jsonResponse(SERIES_INBOUND)],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    const instance = created.find(
      (c) => c.source_id === "gseries_1_20260713T100000Z",
    );
    expect(instance?.properties).toMatchObject({
      original_starts_at: "2026-07-13T10:00:00Z",
    });
  });

  it("binds a moved instance to its series with parent-of, series first", async () => {
    const { ctx, edges } = buildContext({
      proxyResponses: [() => jsonResponse(SERIES_INBOUND)],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(edges).toEqual([
      { source_id: "mit_1", target_id: "mit_2", edge_type: "parent-of" },
    ]);
  });

  it("leaves an instance unbound when its series has not arrived yet", async () => {
    const { ctx, edges, created } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            items: [SERIES_INBOUND.items[1]],
            nextSyncToken: "sync_orphan",
          }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    // The item still lands; only the join waits.
    expect(created).toHaveLength(1);
    expect(edges).toEqual([]);
  });

  it("draws no edge for an ordinary non-recurring event", async () => {
    const { ctx, edges } = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_INBOUND)],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Whole days and split zones
//
// The date an all-day event lands on has to be the same for every reader.
// Google says "whole day" by sending `date` instead of `dateTime`, and the
// mapping used to carry that through as a bare string, leaving the fact
// implied by the formatting and every reader free to re-derive the day in
// its own zone. That is what puts a birthday a day early for everyone west
// of the event.
//
// The ambient-zone runs are the point: nothing has to *pass* a viewer zone
// in for a date derivation to pick one up, because a value derived without
// naming a zone gets the process's.
// ---------------------------------------------------------------------------

/** This package targets Workers and carries no Node types, so the ambient
 *  zone is reached through `globalThis` rather than a bare `process`. The
 *  suite itself runs under Node, where the switch is observable. */
function ambientZoneEnv(): Record<string, string | undefined> | undefined {
  return (
    globalThis as { process?: { env: Record<string, string | undefined> } }
  ).process?.env;
}

async function underAmbientZone(
  zone: string,
  fn: () => Promise<void>,
): Promise<void> {
  const env = ambientZoneEnv();
  const previous = env?.TZ;
  if (env) env.TZ = zone;
  try {
    await fn();
  } finally {
    if (env) {
      if (previous === undefined) delete env.TZ;
      else env.TZ = previous;
    }
  }
}

const ALL_DAY_INBOUND = {
  items: [
    {
      id: "gevt_allday",
      status: "confirmed",
      summary: "Company offsite",
      start: { date: "2026-09-15" },
      end: { date: "2026-09-16" },
      etag: "etag_allday",
    },
  ],
  nextSyncToken: "sync_allday",
};

describe("Google Calendar handlers — whole days", () => {
  it("records all-day as a declared fact on the cross-app type too", async () => {
    // The fidelity type already carried `all_day`; `core.event` did not, so
    // one connection kept the fact and another lost it on a setting nobody
    // was asked about. Both families are driven here for that reason.
    for (const [family, expectedType] of [
      ["core", "core.event"],
      ["google", "google.calendar.event"],
    ] as const) {
      const { ctx, created } = buildContext({
        proxyResponses: [() => jsonResponse(ALL_DAY_INBOUND)],
        connectionRecord: {
          id: "conn_gcal_test",
          type: "system.connection",
          properties: {
            kind: "integration",
            configuration: { write_family: family },
          },
        },
      });
      await handleSchedule(ctx, SCHEDULE_MSG());
      expect(created).toHaveLength(1);
      expect(created[0]!.type).toBe(expectedType);
      expect(created[0]!.properties, expectedType).toMatchObject({
        all_day: true,
      });
    }
  });

  it("stores an instant, not a bare date", async () => {
    const { ctx, created } = buildContext({
      proxyResponses: [() => jsonResponse(ALL_DAY_INBOUND)],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    const props = created[0]!.properties!;
    expect(props.starts_at).toBe("2026-09-15T00:00:00.000Z");
    expect(props.ends_at).toBe("2026-09-16T00:00:00.000Z");
    // And no zone is invented. Calendar states none on a whole day, so
    // claiming one would be a fact it never gave us.
    expect(props.timezone).toBeUndefined();
  });

  it("goes back out on the same calendar date from any zone", async () => {
    // The criterion this exists for: run the outbound mapping east and west
    // of the event and require one date.
    const item: ItemResource = {
      id: "mit_allday",
      type: "core.event",
      state: "active",
      properties: {
        title: "Company offsite",
        starts_at: "2026-09-15T00:00:00.000Z",
        ends_at: "2026-09-16T00:00:00.000Z",
        all_day: true,
      },
    };
    const sent: Record<string, unknown>[] = [];
    for (const viewer of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
      const { ctx, proxyCalls } = buildContext({
        itemForEvent: item,
        proxyResponses: [() => jsonResponse({ id: "gevt_ad", etag: "e" }, 201)],
      });
      await underAmbientZone(viewer, async () => {
        await handleItemEvent(ctx, ITEM_EVENT("mit_allday", "created"));
      });
      sent.push(proxyCalls[0]!.body as Record<string, unknown>);
    }
    for (const body of sent) {
      expect(body.start).toEqual({ date: "2026-09-15" });
      expect(body.end).toEqual({ date: "2026-09-16" });
    }
  });

  it("keeps the date when the event states a zone west of Greenwich", async () => {
    // A whole day written under an explicit zone has to read back on the
    // same day, which is only true if the stored instant is midnight in
    // that zone rather than midnight UTC.
    const item: ItemResource = {
      id: "mit_allday_la",
      type: "core.event",
      state: "active",
      properties: {
        title: "Thanksgiving",
        starts_at: "2026-11-26T08:00:00.000Z", // midnight in Los Angeles
        ends_at: "2026-11-27T08:00:00.000Z",
        timezone: "America/Los_Angeles",
        all_day: true,
      },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent: item,
      proxyResponses: [() => jsonResponse({ id: "gevt_la", etag: "e" }, 201)],
    });
    await underAmbientZone("Pacific/Auckland", async () => {
      await handleItemEvent(ctx, ITEM_EVENT("mit_allday_la", "created"));
    });
    const body = proxyCalls[0]!.body as Record<string, unknown>;
    expect(body.start).toEqual({ date: "2026-11-26" });
  });
});

describe("Google Calendar handlers — an event that ends elsewhere", () => {
  it("carries both zones inbound", async () => {
    const { ctx, created } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            items: [
              {
                id: "gevt_flight",
                status: "confirmed",
                summary: "BER to JFK",
                start: {
                  dateTime: "2026-09-20T10:00:00+02:00",
                  timeZone: "Europe/Berlin",
                },
                end: {
                  dateTime: "2026-09-20T13:30:00-04:00",
                  timeZone: "America/New_York",
                },
              },
            ],
            nextSyncToken: "sync_flight",
          }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(created[0]!.properties).toMatchObject({
      timezone: "Europe/Berlin",
      end_timezone: "America/New_York",
    });
  });

  it("does not invent an end zone when both ends agree", async () => {
    const { ctx, created } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            items: [
              {
                id: "gevt_local",
                status: "confirmed",
                summary: "Standup",
                start: {
                  dateTime: "2026-09-20T09:00:00+02:00",
                  timeZone: "Europe/Berlin",
                },
                end: {
                  dateTime: "2026-09-20T09:30:00+02:00",
                  timeZone: "Europe/Berlin",
                },
              },
            ],
            nextSyncToken: "sync_local",
          }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    const props = created[0]!.properties!;
    expect(props.timezone).toBe("Europe/Berlin");
    expect(props.end_timezone).toBeUndefined();
  });

  it("sends the end zone back out on the end alone", async () => {
    const item: ItemResource = {
      id: "mit_flight",
      type: "core.event",
      state: "active",
      properties: {
        title: "BER to JFK",
        starts_at: "2026-09-20T08:00:00.000Z",
        ends_at: "2026-09-20T17:30:00.000Z",
        timezone: "Europe/Berlin",
        end_timezone: "America/New_York",
      },
    };
    const { ctx, proxyCalls } = buildContext({
      itemForEvent: item,
      proxyResponses: [() => jsonResponse({ id: "gevt_f", etag: "e" }, 201)],
    });
    await handleItemEvent(ctx, ITEM_EVENT("mit_flight", "created"));
    const body = proxyCalls[0]!.body as {
      start: { timeZone?: string };
      end: { timeZone?: string };
    };
    expect(body.start.timeZone).toBe("Europe/Berlin");
    expect(body.end.timeZone).toBe("America/New_York");
  });
});
