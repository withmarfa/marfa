/**
 * Handler-level tests for the Google Drive integration.
 *
 *   - Schedule cold start: getStartPageToken + initial files.list
 *     seeds mapping; cursor.pageToken persists; cursor.seeded flips.
 *   - Schedule incremental: changes.list with persisted pageToken
 *     processes adds, advances pageToken via newStartPageToken.
 *   - Schedule incremental: tombstone-mapping on change.removed=true
 *     and change.file.trashed=true.
 *   - Schedule with inbound_webhook_url: changes.watch channel is
 *     created on cold start and persisted to cursor.channel.
 *   - Webhook handler: sync handshake → ok; non-sync → drives the
 *     same incremental path as schedule.
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
} from "@mymehq/runtime-sdk";
import { handleSchedule, handleWebhook } from "./handlers.js";
import { GOOGLE_DRIVE_MANIFEST } from "./manifest.js";

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

const CONNECTION_ID = "conn_gdrive_test";

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
      return Promise.resolve({ id, type: "google.drive.file" });
    },
    getItem: (id: string) => {
      if (id === CONNECTION_ID) {
        return Promise.resolve(opts.connectionRecord ?? null);
      }
      return Promise.resolve(items.get(id) ?? null);
    },
    transitionItem: (id: string, to: ItemState) => {
      transitions.push({ id, to });
      const existing = items.get(id);
      if (existing) existing.state = to;
      return Promise.resolve({
        id,
        type: "google.drive.file",
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
    integration_name: GOOGLE_DRIVE_MANIFEST.name,
    myme: client,
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
  integration_name: GOOGLE_DRIVE_MANIFEST.name,
  connection_id: CONNECTION_ID,
  scheduled_for_ms: Date.now(),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SEED_FILES = {
  files: [
    {
      id: "drv1",
      name: "Spec doc.md",
      mimeType: "text/markdown",
      size: "1024",
      etag: "etag-drv1",
      modifiedTime: "2026-05-24T01:00:00.000Z",
      owners: [{ emailAddress: "oblix.cyzr@gmail.com" }],
      parents: ["root"],
      trashed: false,
      webViewLink: "https://drive.google.com/file/d/drv1/view",
      md5Checksum: "abc123",
    },
    {
      id: "drv2",
      name: "image.png",
      mimeType: "image/png",
      size: "5120",
      etag: "etag-drv2",
      modifiedTime: "2026-05-24T01:05:00.000Z",
      owners: [{ emailAddress: "oblix.cyzr@gmail.com" }],
      parents: ["folder-a"],
      trashed: false,
      sha256Checksum: "def456abc",
    },
  ],
};

describe("google-drive handleSchedule — cold start", () => {
  it("seeds via startPageToken + files.list, persists cursor, upserts files", async () => {
    const { ctx, created, proxyCalls } = buildContext({
      proxyResponses: [
        // 1. getStartPageToken
        () => jsonResponse({ startPageToken: "page-token-initial" }),
        // 2. files.list initial sweep — one page
        () => jsonResponse(SEED_FILES),
        // 3. changes.list (first incremental sweep — empty result with newStartPageToken)
        () =>
          jsonResponse({
            newStartPageToken: "page-token-after-seed",
            changes: [],
          }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(proxyCalls[0]?.path).toMatch(/\/drive\/v3\/changes\/startPageToken/);
    expect(proxyCalls[1]?.path).toMatch(/\/drive\/v3\/files\?/);
    expect(proxyCalls[1]?.path).toContain("q=trashed%3Dfalse");
    expect(proxyCalls[2]?.path).toMatch(/\/drive\/v3\/changes\?/);
    expect(proxyCalls[2]?.path).toContain("pageToken=page-token-initial");

    expect(created).toHaveLength(2);
    expect(created[0]?.type).toBe("google.drive.file");
    expect(created[0]?.properties).toMatchObject({
      title: "Spec doc.md",
      mime_type: "text/markdown",
      drive_file_id: "drv1",
      size_bytes: 1024,
    });

    const cursor = (await ctx.cursor.read("main")) as {
      mappings: Record<string, string>;
      pageToken: string | null;
      seeded: boolean;
    };
    expect(cursor.seeded).toBe(true);
    expect(cursor.pageToken).toBe("page-token-after-seed");
    expect(cursor.mappings.drv1).toBe("mit_1");
    expect(cursor.mappings.drv2).toBe("mit_2");
  });

  it("trashes mapped Myme items when change.removed=true or change.file.trashed=true", async () => {
    const { ctx, transitions } = buildContext({
      proxyResponses: [
        () =>
          jsonResponse({
            changes: [
              { fileId: "drv-removed", removed: true },
              {
                fileId: "drv-trashed",
                file: { id: "drv-trashed", name: "Was here", trashed: true },
              },
            ],
            newStartPageToken: "page-token-next",
          }),
      ],
    });
    // Pre-seed the cursor so the cold-start path is skipped.
    await ctx.cursor.write("main", {
      mappings: {
        "drv-removed": "mit_removed",
        "drv-trashed": "mit_trashed",
      },
      pageToken: "page-token-current",
      seeded: true,
      last_inbound_at: null,
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(transitions).toContainEqual({ id: "mit_removed", to: "trashed" });
    expect(transitions).toContainEqual({ id: "mit_trashed", to: "trashed" });
  });
});

describe("google-drive handleSchedule — channel renewal", () => {
  it("creates a changes.watch channel on cold start when inbound_webhook_url is configured", async () => {
    const inboundUrl =
      "https://staging.myme.so/runtime/webhook/conn_gdrive_test";
    const { ctx, proxyCalls } = buildContext({
      connectionRecord: {
        id: CONNECTION_ID,
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: { inbound_webhook_url: inboundUrl },
        },
      },
      proxyResponses: [
        // 1. startPageToken (called inside ensureChannel)
        () => jsonResponse({ startPageToken: "wp-1" }),
        // 2. channels/watch
        () =>
          jsonResponse({
            id: "chan-1",
            resourceId: "res-1",
            expiration: String(Date.now() + 6 * 24 * 60 * 60 * 1000),
          }),
        // 3. startPageToken again (cold-start seed in main schedule path; cursor.seeded still false)
        () => jsonResponse({ startPageToken: "wp-2" }),
        // 4. files.list (empty)
        () => jsonResponse({ files: [] }),
        // 5. changes.list (empty + newStartPageToken)
        () => jsonResponse({ newStartPageToken: "wp-3", changes: [] }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    // The first POST is changes/watch.
    const post = proxyCalls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post?.path).toMatch(/\/drive\/v3\/changes\/watch\?pageToken=wp-1/);
    const body = post?.body as {
      type?: string;
      address?: string;
      token?: string;
    };
    expect(body.type).toBe("webhook");
    expect(body.address).toBe(inboundUrl);
    expect(typeof body.token).toBe("string");

    const cursor = (await ctx.cursor.read("main")) as {
      channel?: { channel_id: string; resource_id: string };
    };
    expect(cursor.channel?.resource_id).toBe("res-1");
  });
});

describe("google-drive handleWebhook", () => {
  it("sync handshake → ok with no work", async () => {
    const { ctx, proxyCalls } = buildContext({ proxyResponses: [] });
    const result = await handleWebhook(ctx, {
      delivery_id: "wh-sync",
      headers: { "x-goog-resource-state": "sync" },
      body: new ArrayBuffer(0),
      verified_at_ms: Date.now(),
    });
    expect(result).toEqual({ ok: true });
    expect(proxyCalls).toHaveLength(0);
  });

  it("change push → re-drives the incremental sweep", async () => {
    const { ctx, proxyCalls } = buildContext({
      proxyResponses: [
        // schedule's cold-start: startPageToken + files.list (empty) + changes.list
        () => jsonResponse({ startPageToken: "wp" }),
        () => jsonResponse({ files: [] }),
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });
    const result = await handleWebhook(ctx, {
      delivery_id: "wh-change",
      headers: { "x-goog-resource-state": "change" },
      body: new ArrayBuffer(0),
      verified_at_ms: Date.now(),
    });
    expect(result).toEqual({ ok: true });
    expect(proxyCalls.length).toBeGreaterThanOrEqual(2);
    expect(proxyCalls[0]?.path).toMatch(/startPageToken/);
  });
});
