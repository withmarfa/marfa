/**
 * Handler-level tests for the Google Contacts (People API)
 * integration. Same pattern as google-tasks's handlers.test.ts: build
 * the ConnectionContext inline with the SDK primitives, mock
 * `ctx.marfa` entirely. Coverage focuses on the People-API-specific
 * paths:
 *
 *   - Schedule: connections.list sweep upserts as the configured
 *     target type, mappings populate, syncToken advances.
 *   - Schedule: 410 → syncToken reset, full re-list, fresh syncToken
 *     persisted.
 *   - Schedule: metadata.deleted=true → trash mapped Marfa item.
 *   - Item-event create: clientData marker injected on createContact.
 *   - Item-event create: idempotent recovery — existing person with
 *     marfa-id clientData marker is found, mapping recorded, no fresh POST.
 *   - Item-event update: PATCH carries etag; 409 → refetch + retry once.
 *   - Item-event trash: DELETE on the resource path.
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
import { GOOGLE_CONTACTS_MANIFEST } from "./manifest.js";

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
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  transitions: { id: string; to: ItemState }[];
  proxyCalls: ProxyCall[];
}

const CONNECTION_ID = "conn_gcontacts_test";

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const transitions: { id: string; to: ItemState }[] = [];
  const proxyCalls: ProxyCall[] = [];
  const items = new Map<string, ItemResource>();
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
      } as ItemResource);
      return Promise.resolve({ id, type: input.type });
    },
    updateItem: (id: string, patch: Partial<CreateItemInput>) => {
      updated.push({ id, patch });
      return Promise.resolve({ id, type: "google.contacts.contact" });
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
      return Promise.resolve({
        id,
        type: "google.contacts.contact",
        state: to,
      });
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
    integration_name: GOOGLE_CONTACTS_MANIFEST.name,
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, CONNECTION_ID),
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
  integration_name: GOOGLE_CONTACTS_MANIFEST.name,
  connection_id: CONNECTION_ID,
  scheduled_for_ms: Date.now(),
});

const ITEM_EVENT = (
  itemId: string,
  eventType = "item.created",
  origin = "conn_other",
): ItemEventMessage => ({
  kind: "item-event",
  integration_name: GOOGLE_CONTACTS_MANIFEST.name,
  connection_id: CONNECTION_ID,
  event_type: eventType,
  item_id: itemId,
  cycle: { originating_connection_id: origin, hop_count: 1 },
  payload: {},
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("google-contacts handleSchedule", () => {
  it("sweeps connections.list, upserts as google.contacts.contact, persists syncToken", async () => {
    const { ctx, created, proxyCalls, emitted } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            connections: [
              {
                resourceName: "people/c1",
                etag: "etag-A",
                names: [
                  {
                    givenName: "Ada",
                    familyName: "Lovelace",
                    displayName: "Ada Lovelace",
                  },
                ],
                emailAddresses: [
                  { value: "ada@analytical.engine", type: "work" },
                ],
              },
              {
                resourceName: "people/c2",
                etag: "etag-B",
                names: [{ givenName: "Grace", displayName: "Grace Hopper" }],
              },
            ],
            nextSyncToken: "sync-token-1",
          }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(proxyCalls[0]?.path).toMatch(
      /\/v1\/people\/me\/connections\?personFields=/,
    );
    expect(proxyCalls[0]?.path).toContain("requestSyncToken=true");

    expect(created).toHaveLength(2);
    expect(created[0]?.type).toBe("google.contacts.contact");
    expect(created[0]?.properties).toMatchObject({
      title: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      resource_name: "people/c1",
      etag: "etag-A",
    });

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
      syncToken: string | null;
    };
    expect(cursor.mappings["people/c1"]).toBe("mit_1");
    expect(cursor.mappings["people/c2"]).toBe("mit_2");
    expect(cursor.syncToken).toBe("sync-token-1");

    expect(emitted.at(-1)?.properties?.summary).toMatch(/upserted=2/);
  });

  it("recovers from 410 syncToken expiry: drops token, re-lists fresh, persists new syncToken", async () => {
    const { ctx, proxyCalls, emitted } = buildContext({
      proxyResponses: [
        () => new Response("Gone", { status: 410 }),
        () =>
          jsonResponse({
            connections: [
              {
                resourceName: "people/c-fresh",
                etag: "etag-fresh",
                names: [{ displayName: "Refreshed" }],
              },
            ],
            nextSyncToken: "sync-token-after-410",
          }),
      ],
    });
    // Pre-seed a stale syncToken so the first call passes it.
    await ctx.cursor.write("main", {
      mappings: {},
      syncToken: "stale-token-XYZ",
      last_inbound_at: null,
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(proxyCalls).toHaveLength(2);
    expect(proxyCalls[0]?.path).toContain("syncToken=stale-token-XYZ");
    expect(proxyCalls[1]?.path).not.toContain("syncToken=");
    expect(proxyCalls[1]?.path).toContain("requestSyncToken=true");

    const cursor = (await ctx.cursor.read("main")) as {
      syncToken: string | null;
    };
    expect(cursor.syncToken).toBe("sync-token-after-410");

    const summaries: string[] = emitted.map((e) => {
      const s = e.properties?.summary;
      return typeof s === "string" ? s : "";
    });
    expect(summaries.some((s) => s.includes("syncToken invalidated"))).toBe(
      true,
    );
  });

  it("trashes mapped Marfa item when metadata.deleted=true surfaces", async () => {
    const { ctx, transitions } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            connections: [
              {
                resourceName: "people/c-deleted",
                metadata: { deleted: true },
              },
            ],
            nextSyncToken: "sync-after-tombstone",
          }),
      ],
    });
    await ctx.cursor.write("main", {
      mappings: { "people/c-deleted": "mit_existing" },
      syncToken: "token-pre-delete",
      last_inbound_at: null,
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(transitions).toEqual([{ id: "mit_existing", to: "trashed" }]);
  });
});

describe("google-contacts handleItemEvent — outbound create", () => {
  it("idempotency search first; absent → POSTs createContact with marfa-id clientData marker", async () => {
    const itemForEvent: ItemResource = {
      id: "mit_outbound",
      type: "google.contacts.contact",
      state: "active",
      properties: {
        title: "Alan Turing",
        given_name: "Alan",
        family_name: "Turing",
        emails: [JSON.stringify({ value: "alan@cl.cam.ac.uk", type: "work" })],
      },
    } as ItemResource;
    const { ctx, proxyCalls } = buildContext({
      itemForEvent,
      proxyResponses: [
        () => jsonResponse({ connections: [] }),
        () =>
          jsonResponse({
            resourceName: "people/c-new",
            etag: "etag-new",
            names: [{ displayName: "Alan Turing" }],
          }),
      ],
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("mit_outbound"));
    expect(result).toEqual({ ok: true });
    const postCall = proxyCalls.find((c) => c.method === "POST");
    expect(postCall?.path).toMatch(/\/v1\/people:createContact\?personFields=/);
    const body = postCall?.body as {
      names?: unknown;
      clientData?: { key: string; value: string }[];
    };
    expect(body.clientData).toEqual([
      { key: "marfa-id", value: "mit_outbound" },
    ]);
    expect(body.names).toBeDefined();

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings["people/c-new"]).toBe("mit_outbound");
  });

  it("idempotent recovery: scan finds person with marfa-id marker → mapping recorded, no POST", async () => {
    const itemForEvent: ItemResource = {
      id: "mit_recover",
      type: "google.contacts.contact",
      state: "active",
      properties: { title: "Recovery" },
    } as ItemResource;
    const { ctx, proxyCalls } = buildContext({
      itemForEvent,
      proxyResponses: [
        () =>
          jsonResponse({
            connections: [
              {
                resourceName: "people/c-already-there",
                etag: "etag-existing",
                names: [{ displayName: "Old" }],
                clientData: [{ key: "marfa-id", value: "mit_recover" }],
              },
            ],
          }),
      ],
    });

    const result = await handleItemEvent(ctx, ITEM_EVENT("mit_recover"));
    expect(result).toEqual({ ok: true });
    expect(proxyCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings["people/c-already-there"]).toBe("mit_recover");
  });
});

describe("google-contacts handleItemEvent — outbound update with etag concurrency", () => {
  it("PATCH carries etag; 409 → refetch then retry once with fresh etag", async () => {
    const itemForEvent: ItemResource = {
      id: "mit_patch",
      type: "google.contacts.contact",
      state: "active",
      properties: {
        title: "Patched",
        given_name: "Patched",
        etag: "stale-etag",
      },
    } as ItemResource;
    const { ctx, proxyCalls } = buildContext({
      itemForEvent,
      proxyResponses: [
        // first PATCH → 409
        () =>
          new Response(JSON.stringify({ error: { code: 409 } }), {
            status: 409,
          }),
        // refetch returns fresh etag
        () =>
          jsonResponse({
            resourceName: "people/c-patch",
            etag: "fresh-etag",
            names: [{ displayName: "Old" }],
          }),
        // second PATCH succeeds
        () =>
          jsonResponse({
            resourceName: "people/c-patch",
            etag: "fresh-etag-after-patch",
            names: [{ displayName: "Patched" }],
          }),
      ],
    });
    await ctx.cursor.write("main", {
      mappings: { "people/c-patch": "mit_patch" },
      syncToken: null,
      last_inbound_at: null,
    });

    const result = await handleItemEvent(
      ctx,
      ITEM_EVENT("mit_patch", "item.updated"),
    );
    expect(result).toEqual({ ok: true });

    const patches = proxyCalls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    const firstBody = patches[0]?.body as { etag?: string };
    const secondBody = patches[1]?.body as { etag?: string };
    expect(firstBody.etag).toBe("stale-etag");
    expect(secondBody.etag).toBe("fresh-etag");
  });
});

describe("google-contacts handleItemEvent — trash", () => {
  it("trashed Marfa item → DELETE on the resource path", async () => {
    const itemForEvent: ItemResource = {
      id: "mit_trash",
      type: "google.contacts.contact",
      state: "trashed",
      properties: { title: "Trash me" },
    } as ItemResource;
    const { ctx, proxyCalls } = buildContext({
      itemForEvent,
      proxyResponses: [() => new Response(null, { status: 204 })],
    });
    await ctx.cursor.write("main", {
      mappings: { "people/c-trash": "mit_trash" },
      syncToken: null,
      last_inbound_at: null,
    });

    const result = await handleItemEvent(
      ctx,
      ITEM_EVENT("mit_trash", "item.state_changed"),
    );
    expect(result).toEqual({ ok: true });
    const del = proxyCalls.find((c) => c.method === "DELETE");
    expect(del?.path).toContain("/v1/people/c-trash:deleteContact");
    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
    };
    expect(cursor.mappings["people/c-trash"]).toBeUndefined();
  });
});
