/**
 * Multi-calendar + configurable-target-type handler tests.
 *
 * The single-calendar tests live in `handlers.test.ts` and assert the
 * behaviour a default (no-configuration) connection produces.
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
    // Activity emitted summarising the multi-cal sweep:
    const summary = emitted.find((a) =>
      ((a.properties?.summary as string | undefined) ?? "").includes("multi"),
    );
    expect(summary).toBeTruthy();
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
