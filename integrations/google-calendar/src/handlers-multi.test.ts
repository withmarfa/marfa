/**
 * Multi-calendar + configurable-target-type handler tests.
 *
 * The single-calendar tests live in `handlers.test.ts` and assert the
 * behavior a default (no-configuration) connection produces.
 *
 * Coverage here:
 *   - Inbound: schedule with two selected calendars iterates each with
 *     its own sync cursor; mappings carry per-event calendar_id.
 *   - Inbound: a 410 on one calendar resets only that calendar's cursor;
 *     others continue.
 *   - Inbound: target_type `google.calendar.event` writes the
 *     upstream-fidelity properties (etag, html_link, timezone, all_day,
 *     source_calendar_id).
 *   - Outbound: new event routes to `default_write_calendar_id` (not
 *     primary).
 *   - Outbound: PATCH addresses the mapped calendar (per
 *     `cursor.mapping_calendars`), not the default-write.
 *   - Outbound: all_day=true on the item writes `start.date` instead of
 *     `dateTime`.
 *   - Outbound: timezone on the item writes `start.timeZone`.
 *   - Inbound: each calendar paginates to its own sync token.
 *   - A failed connection-config read surfaces rather than degrading the
 *     connection to single-"primary" mode.
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

interface ProxyCall {
  method: string;
  path: string;
  body: unknown;
}

interface CapturedActivity {
  type: string;
  properties?: Record<string, unknown>;
}

interface BuildOpts {
  /** ctx.marfa.getItem(connection_id) returns this. */
  connectionRecord: Partial<ItemResource>;
  /** When set, ctx.marfa.getItem(connection_id) rejects with this —
   *  simulating a storage blip on the connection-config read. */
  connectionLookupError?: Error;
  /** ctx.marfa.getItem(item_id) for any non-connection id. */
  itemForEvent?: ItemResource | null;
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
  const connectionId = "conn_gcal_multi";

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
      return Promise.resolve({ id, type: "google.calendar.event" });
    },
    getItem: (id: string) => {
      if (id === connectionId) {
        if (opts.connectionLookupError !== undefined) {
          return Promise.reject(opts.connectionLookupError);
        }
        return Promise.resolve(opts.connectionRecord);
      }
      return Promise.resolve(opts.itemForEvent ?? null);
    },
    transitionItem: (id: string, to: ItemState) => {
      transitions.push({ id, to });
      return Promise.resolve({ id, type: "google.calendar.event", state: to });
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
  return { ctx, emitted, created, updated, transitions, proxyCalls };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "google.calendar",
  connection_id: "conn_gcal_multi",
  scheduled_for_ms: Date.now(),
});

const ITEM_EVENT = (
  itemId: string,
  eventType = "updated",
  origin = "conn_other",
): ItemEventMessage => ({
  kind: "item-event",
  integration_name: "google.calendar",
  connection_id: "conn_gcal_multi",
  event_type: eventType,
  item_id: itemId,
  cycle: { originating_connection_id: origin, hop_count: 1 },
  payload: {},
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Minimal confirmed event — enough for the ingest path to upsert it. */
function multiEvent(id: string): Record<string, unknown> {
  return {
    id,
    etag: `etag_${id}`,
    summary: `Event ${id}`,
    start: { dateTime: "2026-05-01T09:00:00Z" },
    end: { dateTime: "2026-05-01T10:00:00Z" },
    status: "confirmed",
  };
}

function multiCalendarConnection(): Partial<ItemResource> {
  return {
    id: "conn_gcal_multi",
    type: "system.connection",
    properties: {
      kind: "integration",
      configuration: {
        selected_calendar_ids: ["primary", "team@example.com"],
        default_write_calendar_id: "primary",
        target_type: "google.calendar.event",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound — schedule across two calendars
// ---------------------------------------------------------------------------

describe("handleSchedule — multi-calendar inbound", () => {
  it("sweeps every selected calendar and records per-event calendar_id", async () => {
    const { ctx, created, proxyCalls, emitted } = buildContext({
      connectionRecord: multiCalendarConnection(),
      proxyResponses: [
        () =>
          jsonResponse({
            items: [
              {
                id: "gevt_primary_1",
                etag: "etag_p1",
                summary: "Primary 1",
                start: { dateTime: "2026-05-01T09:00:00Z" },
                end: { dateTime: "2026-05-01T10:00:00Z" },
                status: "confirmed",
              },
            ],
            nextSyncToken: "sync_primary_after",
          }),
        () =>
          jsonResponse({
            items: [
              {
                id: "gevt_team_1",
                etag: "etag_t1",
                summary: "Team Standup",
                start: {
                  dateTime: "2026-05-02T14:00:00Z",
                  timeZone: "Europe/London",
                },
                end: {
                  dateTime: "2026-05-02T14:30:00Z",
                  timeZone: "Europe/London",
                },
                status: "confirmed",
              },
            ],
            nextSyncToken: "sync_team_after",
          }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);
    // Both calendars hit by the proxy:
    expect(proxyCalls.length).toBe(2);
    expect(proxyCalls[0]?.path).toContain(
      "/calendars/primary/events?maxResults=250",
    );
    expect(proxyCalls[1]?.path).toContain(
      "/calendars/team%40example.com/events?maxResults=250",
    );
    // Two events created — one from each calendar:
    expect(created.length).toBe(2);
    const primaryCreated = created.find(
      (c) => (c.properties as { title?: string }).title === "Primary 1",
    );
    const teamCreated = created.find(
      (c) => (c.properties as { title?: string }).title === "Team Standup",
    );
    expect(primaryCreated?.type).toBe("google.calendar.event");
    expect(teamCreated?.type).toBe("google.calendar.event");
    // Source calendar id is round-tripped onto the item:
    expect(
      (primaryCreated?.properties as { source_calendar_id?: string })
        .source_calendar_id,
    ).toBe("primary");
    expect(
      (teamCreated?.properties as { source_calendar_id?: string })
        .source_calendar_id,
    ).toBe("team@example.com");
    // Timezone round-trips on the team event:
    expect((teamCreated?.properties as { timezone?: string }).timezone).toBe(
      "Europe/London",
    );
    // etag captured:
    expect((primaryCreated?.properties as { etag?: string }).etag).toBe(
      "etag_p1",
    );
    // Activity emitted summarizing the multi-cal sweep:
    const summary = emitted.find((a) =>
      ((a.properties?.summary as string | undefined) ?? "").includes("multi"),
    );
    expect(summary).toBeTruthy();
  });

  // A connection that names its calendars but nominates no write target used
  // to fall through to the primary-only path: the other selected calendars
  // were skipped on the way in and outbound writes went to primary, with
  // nothing to tell the degraded run from a healthy one. The selection alone
  // now decides, and the first selected calendar receives writes.
  it("sweeps every selected calendar when no write target is nominated", async () => {
    const { ctx, created, proxyCalls } = buildContext({
      connectionRecord: {
        id: "conn_gcal_selection_only",
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: {
            selected_calendar_ids: ["primary", "team@example.com"],
          },
        },
      },
      proxyResponses: [
        () =>
          jsonResponse({
            items: [multiEvent("gevt_primary_1")],
            nextSyncToken: "sync_primary_after",
          }),
        () =>
          jsonResponse({
            items: [multiEvent("gevt_team_1")],
            nextSyncToken: "sync_team_after",
          }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);
    // Both selected calendars swept, not just primary.
    expect(proxyCalls.length).toBe(2);
    expect(proxyCalls[1]?.path).toContain("/calendars/team%40example.com/");
    // Multi mode's target type, not the primary-only path's core.event.
    expect(created.length).toBe(2);
    expect(created.every((c) => c.type === "google.calendar.event")).toBe(true);
  });

  it("410 on one calendar resets only that calendar's syncToken; others continue", async () => {
    const { ctx, created, emitted } = buildContext({
      connectionRecord: multiCalendarConnection(),
      proxyResponses: [
        // Primary returns 410 → cursor reset, no events processed.
        () => new Response("sync token expired", { status: 410 }),
        // Team continues normally.
        () =>
          jsonResponse({
            items: [
              {
                id: "gevt_team_1",
                etag: "etag_t1",
                summary: "Team Event",
                start: { dateTime: "2026-05-02T14:00:00Z" },
                end: { dateTime: "2026-05-02T15:00:00Z" },
                status: "confirmed",
              },
            ],
            nextSyncToken: "sync_team_after",
          }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);
    // Team event created; primary skipped due to 410:
    expect(created.length).toBe(1);
    expect((created[0]?.properties as { title?: string }).title).toBe(
      "Team Event",
    );
    // Activity row emitted for the primary's 410 reset:
    const resetActivity = emitted.find((a) =>
      ((a.properties?.summary as string | undefined) ?? "").includes(
        "syncToken invalidated for primary",
      ),
    );
    expect(resetActivity).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Outbound — item-event routing
// ---------------------------------------------------------------------------

describe("handleItemEvent — multi-calendar outbound", () => {
  it("routes new events to the configured default_write_calendar_id", async () => {
    const item: ItemResource = {
      id: "mit_new_event",
      type: "google.calendar.event",
      state: "active",
      properties: {
        title: "Outbound test",
        starts_at: "2026-06-01T10:00:00Z",
        ends_at: "2026-06-01T11:00:00Z",
      },
    };

    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalendarConnection(),
      itemForEvent: item,
      proxyResponses: [
        () =>
          jsonResponse({
            id: "gevt_created",
            etag: "etag_created",
            summary: "Outbound test",
            start: { dateTime: "2026-06-01T10:00:00Z" },
            end: { dateTime: "2026-06-01T11:00:00Z" },
          }),
      ],
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT(item.id, "created"));
    expect(result.ok).toBe(true);
    expect(proxyCalls.length).toBe(1);
    // POST went to the default_write calendar (`primary`) — not the second
    // selected calendar.
    expect(proxyCalls[0]?.method).toBe("POST");
    expect(proxyCalls[0]?.path).toContain("/calendars/primary/events");
    // Deterministic id stamped onto the payload for idempotent retries.
    const postBody = proxyCalls[0]?.body as { id?: string };
    expect(typeof postBody.id).toBe("string");
    expect((postBody.id ?? "").length).toBe(64); // SHA-256 hex digest
  });

  it("writes all_day events as start.date instead of start.dateTime", async () => {
    const item: ItemResource = {
      id: "mit_allday",
      type: "google.calendar.event",
      state: "active",
      properties: {
        title: "All-day",
        starts_at: "2026-07-04",
        ends_at: "2026-07-05",
        all_day: true,
      },
    };

    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalendarConnection(),
      itemForEvent: item,
      proxyResponses: [
        () =>
          jsonResponse({
            id: "gevt_allday",
            etag: "etag_allday",
            summary: "All-day",
            start: { date: "2026-07-04" },
            end: { date: "2026-07-05" },
          }),
      ],
    });

    await handleItemEvent(ctx, ITEM_EVENT(item.id, "created"));
    const postBody = proxyCalls[0]?.body as {
      start?: { date?: string; dateTime?: string };
      end?: { date?: string; dateTime?: string };
    };
    expect(postBody.start?.date).toBe("2026-07-04");
    expect(postBody.start?.dateTime).toBeUndefined();
    expect(postBody.end?.date).toBe("2026-07-05");
    expect(postBody.end?.dateTime).toBeUndefined();
  });

  it("writes timezone on start/end when item carries it", async () => {
    const item: ItemResource = {
      id: "mit_tz",
      type: "google.calendar.event",
      state: "active",
      properties: {
        title: "TZ event",
        starts_at: "2026-09-12T09:00:00",
        ends_at: "2026-09-12T10:00:00",
        timezone: "America/New_York",
      },
    };

    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalendarConnection(),
      itemForEvent: item,
      proxyResponses: [
        () =>
          jsonResponse({
            id: "gevt_tz",
            etag: "etag_tz",
            summary: "TZ event",
            start: {
              dateTime: "2026-09-12T09:00:00",
              timeZone: "America/New_York",
            },
            end: {
              dateTime: "2026-09-12T10:00:00",
              timeZone: "America/New_York",
            },
          }),
      ],
    });

    await handleItemEvent(ctx, ITEM_EVENT(item.id, "created"));
    const postBody = proxyCalls[0]?.body as {
      start?: { timeZone?: string; dateTime?: string };
      end?: { timeZone?: string; dateTime?: string };
    };
    expect(postBody.start?.timeZone).toBe("America/New_York");
    expect(postBody.start?.dateTime).toBe("2026-09-12T09:00:00");
    expect(postBody.end?.timeZone).toBe("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// Pagination across a multi-calendar sweep
// ---------------------------------------------------------------------------

describe("handleSchedule — multi-calendar pagination", () => {
  it("paginates each calendar independently to its own sync token", async () => {
    const { ctx, created, proxyCalls } = buildContext({
      connectionRecord: multiCalendarConnection(),
      proxyResponses: [
        // primary, page 1 of 2
        () =>
          jsonResponse({
            items: [multiEvent("gevt_primary_1")],
            nextPageToken: "tok_primary_2",
          }),
        // primary, page 2 of 2
        () =>
          jsonResponse({
            items: [multiEvent("gevt_primary_2")],
            nextSyncToken: "sync_primary_after",
          }),
        // team, single page
        () =>
          jsonResponse({
            items: [multiEvent("gevt_team_1")],
            nextSyncToken: "sync_team_after",
          }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);
    expect(proxyCalls).toHaveLength(3);
    expect(proxyCalls[1]!.path).toContain("pageToken=tok_primary_2");
    expect(proxyCalls[2]!.path).toContain("/calendars/team%40example.com/");
    expect(proxyCalls[2]!.path).not.toContain("pageToken");
    expect(created).toHaveLength(3);

    const cursor = (await ctx.cursor.read("main")) as {
      per_calendar: Record<
        string,
        { syncToken: string | null; pageToken: string | null }
      >;
    };
    expect(cursor.per_calendar.primary?.syncToken).toBe("sync_primary_after");
    expect(cursor.per_calendar.primary?.pageToken).toBeNull();
    expect(cursor.per_calendar["team@example.com"]?.syncToken).toBe(
      "sync_team_after",
    );
  });
});

// ---------------------------------------------------------------------------
// Connection-config lookup failure
// ---------------------------------------------------------------------------

describe("connection-config lookup failure", () => {
  it("surfaces a failed inbound config read instead of sweeping as single/primary", async () => {
    const { ctx, proxyCalls, emitted } = buildContext({
      connectionRecord: multiCalendarConnection(),
      connectionLookupError: new Error("storage unavailable"),
      proxyResponses: [],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toMatchObject({ ok: false, retry: true });
    // No upstream call at all — the handler must not guess at "primary".
    expect(proxyCalls).toHaveLength(0);
    const required = emitted.filter(
      (e) => e.properties?.severity === "action_required",
    );
    expect(required).toHaveLength(1);
    expect(required[0]!.properties?.summary).toMatch(
      /connection configuration lookup failed/,
    );
  });

  it("surfaces a failed outbound config read instead of writing to primary", async () => {
    // The silent-degradation shape this guards against: a multi-calendar
    // connection whose config read blips writes the event to "primary"
    // rather than its nominated default-write calendar, with nothing in
    // the activity feed to say so.
    const item: ItemResource = {
      id: "mit_cfg",
      type: "google.calendar.event",
      state: "active",
      properties: { title: "Should not reach primary" },
    };
    const { ctx, proxyCalls, emitted } = buildContext({
      connectionRecord: multiCalendarConnection(),
      connectionLookupError: new Error("storage unavailable"),
      itemForEvent: item,
      proxyResponses: [() => jsonResponse({ id: "gevt_x", etag: "e" }, 201)],
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("mit_cfg", "created"));
    expect(result).toMatchObject({ ok: false, retry: true });
    expect(proxyCalls).toHaveLength(0);
    expect(
      emitted.some((e) =>
        ((e.properties?.summary as string | undefined) ?? "").includes(
          "connection configuration lookup failed",
        ),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Moving from the single-calendar shape to the multi one
// ---------------------------------------------------------------------------

/**
 * A connection installed with no configuration syncs the primary calendar and
 * accumulates a single-shaped cursor. The moment the picker saves a selection
 * it resolves to multi mode, and everything it recorded has to survive the
 * move. Both cases below seed exactly what single mode leaves behind: a
 * top-level `syncToken`, and mappings with no `mapping_calendars` beside them.
 */
describe("adopting a single-calendar cursor", () => {
  const legacyCursor = {
    syncToken: "token_from_single_mode",
    last_inbound_at: "2026-05-01T00:00:00.000Z",
    mappings: { gevt_from_single: "mit_from_single" },
  };

  /** Write target is deliberately NOT primary, so a wrong guess is visible. */
  function selectionWritingElsewhere(): Partial<ItemResource> {
    return {
      id: "conn_gcal_multi",
      type: "system.connection",
      properties: {
        kind: "integration",
        configuration: {
          selected_calendar_ids: ["primary", "team@example.com"],
          default_write_calendar_id: "team@example.com",
          target_type: "google.calendar.event",
        },
      },
    };
  }

  it("carries the old sync position onto the primary calendar", async () => {
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: selectionWritingElsewhere(),
      proxyResponses: [
        () => jsonResponse({ items: [], nextSyncToken: "token_primary_next" }),
        () => jsonResponse({ items: [], nextSyncToken: "token_team_next" }),
      ],
    });
    await ctx.cursor.write("main", legacyCursor);

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);

    // Without the adoption the sweep starts from nothing, and a token-less
    // list does not carry the cancellations from the gap, so deletions that
    // happened while the connection was in single mode are never seen and
    // their Marfa items are stranded.
    expect(proxyCalls[0]?.path).toContain("/calendars/primary/");
    expect(proxyCalls[0]?.path).toContain("syncToken=token_from_single_mode");
    // The newly selected calendar has no history and correctly starts fresh.
    expect(proxyCalls[1]?.path).toContain("/calendars/team%40example.com/");
    expect(proxyCalls[1]?.path).not.toContain("syncToken=");
  });

  it("deletes a pre-existing event on the calendar it actually lives on", async () => {
    const item: ItemResource = {
      id: "mit_from_single",
      type: "google.calendar.event",
      state: "trashed",
      properties: { title: "Synced before the selection existed" },
    };

    const { ctx, proxyCalls } = buildContext({
      connectionRecord: selectionWritingElsewhere(),
      itemForEvent: item,
      proxyResponses: [() => new Response(null, { status: 204 })],
    });
    await ctx.cursor.write("main", legacyCursor);

    await handleItemEvent(ctx, ITEM_EVENT(item.id, "updated"));

    // Every mapping single mode wrote is on primary. Addressing the write
    // target instead sends the DELETE to a calendar the event was never on,
    // and a 404 there reads as "already gone" — so Marfa would report the
    // event deleted, drop the mapping, and leave it on the user's calendar.
    expect(proxyCalls[0]?.path).toContain("/calendars/primary/events/");
    expect(proxyCalls[0]?.path).not.toContain("team%40example.com");
  });
});
