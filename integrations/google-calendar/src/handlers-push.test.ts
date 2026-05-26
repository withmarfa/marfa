/**
 * Push-notification tests — `channels.watch` lifecycle (create + renew
 * + stop) driven from the schedule handler, plus the `handleWebhook`
 * receipt path that triggers an immediate per-calendar re-sync.
 *
 * These tests deliberately do NOT modify any pre-T-231 fixtures or
 * legacy-mode behaviour — push notifications only activate when the
 * connection's configuration carries both `selected_calendar_ids` AND
 * an `inbound_webhook_url`.
 *
 * Coverage:
 *   - Channel create on first schedule run when no channel exists.
 *   - Channel skip when an existing channel is still well within
 *     renewal leeway.
 *   - Channel renewal (create new BEFORE stop old — zero-downtime) when
 *     existing channel is within `CHANNEL_RENEW_LEEWAY_MS` of expiry.
 *   - Schedule sweep skips channel management entirely when
 *     `inbound_webhook_url` is unset (graceful degradation to
 *     schedule-only).
 *   - `handleWebhook` extracts calendar id from `X-Goog-Resource-URI`
 *     and triggers a per-calendar re-sync.
 *   - `handleWebhook` acks the `sync` handshake without re-polling.
 *   - `handleWebhook` acks pushes for unknown / unselected calendar ids
 *     without re-polling.
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
  type ScheduleMessage,
  type WebhookHandlerInput,
} from "@withmarfa/runtime-sdk";
import { handleSchedule, handleWebhook } from "./handlers.js";

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

interface BuildOpts {
  connectionRecord: Partial<ItemResource>;
  proxyResponses: (() => Response)[];
  /** Seed value for the cursor (useful for "channel close to expiry" tests). */
  cursorSeed?: Record<string, unknown>;
}

interface BuiltContext {
  ctx: ConnectionContext;
  proxyCalls: ProxyCall[];
  storage: InMemoryStorage;
}

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const created: CreateItemInput[] = [];
  const proxyCalls: ProxyCall[] = [];
  let proxyIdx = 0;
  const connectionId = "conn_gcal_push";

  if (opts.cursorSeed !== undefined) {
    void storage.put("cursor:main", opts.cursorSeed);
  }

  const client = {
    createItem: (input: CreateItemInput) => {
      created.push(input);
      if (input.type === "system.activity") {
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      return Promise.resolve({
        id: `mit_${String(created.length)}`,
        type: input.type,
      });
    },
    updateItem: (id: string) =>
      Promise.resolve({ id, type: "google.calendar.event" }),
    getItem: (id: string) => {
      if (id === connectionId) {
        return Promise.resolve(opts.connectionRecord);
      }
      return Promise.resolve(null);
    },
    transitionItem: (id: string, to: ItemState) =>
      Promise.resolve({ id, type: "google.calendar.event", state: to }),
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
  return { ctx, proxyCalls, storage };
}

function multiCalConnectionWithWebhook(
  selectedCalendarIds: string[] = ["primary"],
): Partial<ItemResource> {
  return {
    id: "conn_gcal_push",
    type: "system.connection",
    properties: {
      kind: "integration",
      configuration: {
        selected_calendar_ids: selectedCalendarIds,
        default_write_calendar_id: selectedCalendarIds[0] ?? "primary",
        target_type: "google.calendar.event",
        inbound_webhook_url:
          "https://staging.marfa.so/webhooks/inbound/conn_gcal_push",
      },
    },
  };
}

function multiCalConnectionWithoutWebhook(): Partial<ItemResource> {
  return {
    id: "conn_gcal_push",
    type: "system.connection",
    properties: {
      kind: "integration",
      configuration: {
        selected_calendar_ids: ["primary"],
        default_write_calendar_id: "primary",
        target_type: "google.calendar.event",
        // inbound_webhook_url deliberately absent
      },
    },
  };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "google.calendar",
  connection_id: "conn_gcal_push",
  scheduled_for_ms: Date.now(),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// ---------------------------------------------------------------------------
// Channel create on first run
// ---------------------------------------------------------------------------

describe("handleSchedule — channel create on first run", () => {
  it("creates a watch channel for each selected calendar when none exists yet", async () => {
    const { ctx, proxyCalls, storage } = buildContext({
      connectionRecord: multiCalConnectionWithWebhook(["primary"]),
      proxyResponses: [
        // 1. channels.watch POST → returns channel state
        () =>
          jsonResponse({
            id: "channel-xyz",
            resourceId: "resource-xyz",
            expiration: String(Date.now() + 6 * 24 * 60 * 60 * 1000),
          }),
        // 2. events.list GET → empty sweep
        () => jsonResponse({ items: [], nextSyncToken: "sync_after" }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);

    // First call is the channel.watch POST
    expect(proxyCalls[0]?.method).toBe("POST");
    expect(proxyCalls[0]?.path).toBe(
      "/calendar/v3/calendars/primary/events/watch",
    );
    const watchBody = proxyCalls[0]?.body as {
      id: string;
      type: string;
      address: string;
      token: string;
      expiration: string;
    };
    expect(watchBody.type).toBe("webhook");
    expect(watchBody.address).toBe(
      "https://staging.marfa.so/webhooks/inbound/conn_gcal_push",
    );
    expect(typeof watchBody.token).toBe("string");
    expect(watchBody.token.length).toBe(64); // 32 bytes hex

    // Cursor now carries the channel state.
    const persisted = (await storage.get("cursor:main")) as {
      channels?: Record<string, { channel_id: string; resource_id: string }>;
    };
    expect(persisted.channels?.primary?.channel_id).toBeTruthy();
    expect(persisted.channels?.primary?.resource_id).toBe("resource-xyz");
  });

  it("skips channel management entirely when inbound_webhook_url is unset", async () => {
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalConnectionWithoutWebhook(),
      proxyResponses: [
        () => jsonResponse({ items: [], nextSyncToken: "sync_after" }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);

    // No channels.watch POST — the only call is the events.list GET.
    const watchCalls = proxyCalls.filter((c) =>
      c.path.includes("/events/watch"),
    );
    expect(watchCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Channel renewal (zero-downtime: create new BEFORE stop old)
// ---------------------------------------------------------------------------

describe("handleSchedule — channel renewal", () => {
  it("renews when existing channel is within renewal leeway; creates new BEFORE stopping old", async () => {
    // Seed cursor with a channel that expires in 1 hour (well within
    // the 24-hour renewal leeway).
    const expiringSoon = Date.now() + 60 * 60 * 1000;
    const { ctx, proxyCalls, storage } = buildContext({
      connectionRecord: multiCalConnectionWithWebhook(["primary"]),
      cursorSeed: {
        syncToken: null,
        last_inbound_at: null,
        mappings: {},
        per_calendar: { primary: { syncToken: null, last_inbound_at: null } },
        channels: {
          primary: {
            channel_id: "old-channel",
            resource_id: "old-resource",
            expiration_ms: expiringSoon,
            channel_token: "old-token-1234567890",
          },
        },
      },
      proxyResponses: [
        // 1. channels.watch POST → new channel
        () =>
          jsonResponse({
            id: "new-channel",
            resourceId: "new-resource",
            expiration: String(Date.now() + 6 * 24 * 60 * 60 * 1000),
          }),
        // 2. channels.stop POST → ok (the OLD channel is stopped)
        () => new Response(null, { status: 204 }),
        // 3. events.list GET
        () => jsonResponse({ items: [], nextSyncToken: "sync_after" }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);

    // Order matters: POST new channel first, THEN POST stop old.
    expect(proxyCalls[0]?.path).toBe(
      "/calendar/v3/calendars/primary/events/watch",
    );
    expect(proxyCalls[1]?.path).toBe("/calendar/v3/channels/stop");
    const stopBody = proxyCalls[1]?.body as {
      id: string;
      resourceId: string;
    };
    expect(stopBody.id).toBe("old-channel");
    expect(stopBody.resourceId).toBe("old-resource");

    // Cursor now points at the new channel. The channel_id is the
    // UUID we generated and sent to Google (which Google echoes back);
    // assert it's a fresh UUID (NOT the old "old-channel" id) and the
    // resource_id comes from the server's response.
    const persisted = (await storage.get("cursor:main")) as {
      channels: Record<string, { channel_id: string; resource_id: string }>;
    };
    const primaryChannel = persisted.channels.primary;
    expect(primaryChannel).toBeDefined();
    expect(primaryChannel?.channel_id).not.toBe("old-channel");
    expect(primaryChannel?.channel_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(primaryChannel?.resource_id).toBe("new-resource");
  });

  it("does NOT renew when existing channel has plenty of life left", async () => {
    // Channel expires in 5 days — well outside the 1-day renewal leeway.
    const expiringLater = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalConnectionWithWebhook(["primary"]),
      cursorSeed: {
        syncToken: null,
        last_inbound_at: null,
        mappings: {},
        per_calendar: { primary: { syncToken: null, last_inbound_at: null } },
        channels: {
          primary: {
            channel_id: "current-channel",
            resource_id: "current-resource",
            expiration_ms: expiringLater,
            channel_token: "current-token",
          },
        },
      },
      proxyResponses: [
        // Only an events.list GET — no channels.watch, no channels.stop.
        () => jsonResponse({ items: [], nextSyncToken: "sync_after" }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result.ok).toBe(true);

    const watchCalls = proxyCalls.filter((c) =>
      c.path.includes("/events/watch"),
    );
    const stopCalls = proxyCalls.filter((c) =>
      c.path.includes("/channels/stop"),
    );
    expect(watchCalls.length).toBe(0);
    expect(stopCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleWebhook
// ---------------------------------------------------------------------------

function webhookInput(
  resourceUri: string,
  resourceState = "exists",
): WebhookHandlerInput {
  return {
    delivery_id: "delivery-abc",
    headers: {
      "x-goog-channel-id": "channel-xyz",
      "x-goog-resource-uri": resourceUri,
      "x-goog-resource-state": resourceState,
      "x-goog-message-number": "42",
    },
    body: new ArrayBuffer(0),
    verified_at_ms: Date.now(),
  };
}

describe("handleWebhook — push notifications", () => {
  it("extracts the calendar id from X-Goog-Resource-URI and triggers a re-sync", async () => {
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalConnectionWithWebhook(["primary"]),
      proxyResponses: [
        // Webhook handler triggers events.list directly (no channel
        // mgmt — that's the schedule handler's job).
        () =>
          jsonResponse({
            items: [
              {
                id: "gevt_pushed",
                etag: "etag_pushed",
                summary: "Pushed event",
                start: { dateTime: "2026-08-01T10:00:00Z" },
                end: { dateTime: "2026-08-01T11:00:00Z" },
                status: "confirmed",
              },
            ],
            nextSyncToken: "sync_after_push",
          }),
      ],
    });

    const result = await handleWebhook(
      ctx,
      webhookInput(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json",
      ),
    );
    expect(result.ok).toBe(true);
    expect(proxyCalls.length).toBe(1);
    expect(proxyCalls[0]?.path).toContain(
      "/calendar/v3/calendars/primary/events?",
    );
  });

  it("decodes URL-encoded calendar ids (team@example.com)", async () => {
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalConnectionWithWebhook(["team@example.com"]),
      proxyResponses: [
        () => jsonResponse({ items: [], nextSyncToken: "sync_team" }),
      ],
    });

    await handleWebhook(
      ctx,
      webhookInput(
        "https://www.googleapis.com/calendar/v3/calendars/team%40example.com/events?alt=json",
      ),
    );
    expect(proxyCalls[0]?.path).toContain("team%40example.com");
  });

  it("acks the `sync` handshake without triggering a re-poll", async () => {
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalConnectionWithWebhook(["primary"]),
      proxyResponses: [],
    });

    const result = await handleWebhook(
      ctx,
      webhookInput(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json",
        "sync",
      ),
    );
    expect(result.ok).toBe(true);
    expect(proxyCalls.length).toBe(0);
  });

  it("acks pushes for unknown calendar ids without re-polling", async () => {
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: multiCalConnectionWithWebhook(["primary"]),
      proxyResponses: [],
    });

    const result = await handleWebhook(
      ctx,
      webhookInput(
        "https://www.googleapis.com/calendar/v3/calendars/orphan-cal/events?alt=json",
      ),
    );
    expect(result.ok).toBe(true);
    expect(proxyCalls.length).toBe(0);
  });

  it("acks pushes for legacy single-calendar connections (push not active)", async () => {
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: {
        id: "conn_gcal_push",
        type: "system.connection",
        properties: {
          kind: "integration",
          // No selected_calendar_ids → legacy mode → no push.
        },
      },
      proxyResponses: [],
    });

    const result = await handleWebhook(
      ctx,
      webhookInput(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json",
      ),
    );
    expect(result.ok).toBe(true);
    expect(proxyCalls.length).toBe(0);
  });
});
