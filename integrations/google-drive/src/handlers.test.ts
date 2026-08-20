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
  type UploadBlobInput,
  type UploadBlobResult,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
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

interface CapturedUpload {
  content: Uint8Array;
  mime_type: string;
  hash: string;
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  transitions: { id: string; to: ItemState }[];
  proxyCalls: ProxyCall[];
  uploads: CapturedUpload[];
}

const CONNECTION_ID = "conn_gdrive_test";

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const transitions: { id: string; to: ItemState }[] = [];
  const proxyCalls: ProxyCall[] = [];
  const uploads: CapturedUpload[] = [];
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
      });
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
    uploadBlob: async (input: UploadBlobInput): Promise<UploadBlobResult> => {
      const bytes =
        input.content instanceof Uint8Array
          ? input.content
          : new Uint8Array(input.content);
      // Uses SubtleCrypto so this works in both Node and Workers runtimes.
      // Copy into a fresh ArrayBuffer to avoid SharedArrayBuffer rejection.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
      const hex = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const hash = `sha256:${hex}`;
      uploads.push({
        content: new Uint8Array(bytes),
        mime_type: input.mime_type,
        hash,
      });
      return {
        hash,
        mime_type: input.mime_type,
        size: bytes.byteLength,
      };
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: CONNECTION_ID,
    integration_name: GOOGLE_DRIVE_MANIFEST.name,
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
  return { ctx, emitted, created, updated, transitions, proxyCalls, uploads };
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

  it("trashes mapped Marfa items when change.removed=true or change.file.trashed=true", async () => {
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
      "https://staging.marfa.so/runtime/webhook/conn_gdrive_test";
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

// ---------------------------------------------------------------------------
// download_mode = "all-files"
//
// Three byte-ingest outcomes coexist in one run: a PDF gets uploaded
// and stamped as core.file with sha256 blob_ref; a Google-native file
// is skipped silently with a run-summary counter; an oversize file is
// skipped per-file. Both skip kinds emit `info` activity (no
// action_required noise for "we couldn't fetch this"); per-file
// download failures use the same `info` shape since the next sync
// retries automatically.
// ---------------------------------------------------------------------------

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
]);

function binaryResponse(bytes: Uint8Array, contentType: string): Response {
  // Cast to BodyInit; Workers / Node fetch both accept Uint8Array
  // bodies at runtime, but some lib.dom configurations narrow
  // BodyInit to a union that excludes the bare Uint8Array.
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

function allFilesConnectionRecord(
  ceiling: number = 25 * 1024 * 1024,
): Partial<ItemResource> {
  return {
    id: CONNECTION_ID,
    type: "system.connection",
    properties: {
      kind: "integration",
      configuration: {
        write_family: "google",
        download_mode: "all-files",
        max_file_size_bytes: ceiling,
      },
    },
  };
}

describe("google-drive handleSchedule — all-files mode", () => {
  it("uploads bytes for downloadable files and stamps blob_ref (google family keeps google.drive.file)", async () => {
    const { ctx, created, uploads, emitted } = buildContext({
      connectionRecord: allFilesConnectionRecord(),
      proxyResponses: [
        // startPageToken
        () => jsonResponse({ startPageToken: "wp-1" }),
        // files.list: one PDF
        () =>
          jsonResponse({
            files: [
              {
                id: "drv-pdf",
                name: "spec.pdf",
                mimeType: "application/pdf",
                size: "8",
                modifiedTime: "2026-05-24T01:00:00.000Z",
                md5Checksum: "md5-pdf",
                webViewLink: "https://drive.google.com/file/d/drv-pdf/view",
              },
            ],
          }),
        // alt=media GET for drv-pdf (proxy download)
        () => binaryResponse(PDF_BYTES, "application/pdf"),
        // changes.list — empty
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.mime_type).toBe("application/pdf");
    expect(Array.from(uploads[0]!.content)).toEqual(Array.from(PDF_BYTES));

    // Operator chose `google.drive.file` — they keep the
    // upstream-fidelity type and `blob_ref` lands as an optional
    // populated property. (Type-routing only downgrades on failure;
    // it never upgrades against the configured preference.)
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("google.drive.file");
    expect(created[0]?.properties?.blob_ref).toBe(uploads[0]!.hash);
    expect(String(created[0]?.properties?.blob_ref)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(created[0]?.properties?.mime_type).toBe("application/pdf");

    // Run summary carries the per-mode counters.
    const summary = emitted.find((a) =>
      String(a.properties?.summary).includes("download_mode=all-files"),
    );
    expect(summary).toBeDefined();
    expect(String(summary?.properties?.summary)).toContain("files_with_blob=1");
    expect(String(summary?.properties?.summary)).toContain(
      "skipped_google_native=0",
    );
    expect(String(summary?.properties?.summary)).toContain("oversize=0");
    expect(String(summary?.properties?.summary)).toContain("download_failed=0");
  });

  it("emits core.file when the operator configures the core family AND bytes ingested", async () => {
    const { ctx, created, uploads } = buildContext({
      connectionRecord: {
        id: CONNECTION_ID,
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: {
            write_family: "core",
            download_mode: "all-files",
          },
        },
      },
      proxyResponses: [
        () => jsonResponse({ startPageToken: "wp-1" }),
        () =>
          jsonResponse({
            files: [
              {
                id: "drv-pdf2",
                name: "essay.pdf",
                mimeType: "application/pdf",
                size: "8",
                webViewLink: "https://drive.google.com/file/d/drv-pdf2/view",
              },
            ],
          }),
        () => binaryResponse(PDF_BYTES, "application/pdf"),
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(uploads).toHaveLength(1);
    expect(created).toHaveLength(1);
    // Configured = core family + bytes ingested → core.file with blob_ref +
    // the cross-app `url` property pointing at the Drive web view.
    expect(created[0]?.type).toBe("core.file");
    expect(created[0]?.properties?.blob_ref).toBe(uploads[0]!.hash);
    expect(created[0]?.properties?.url).toBe(
      "https://drive.google.com/file/d/drv-pdf2/view",
    );
  });

  it("honors a legacy stored target_type by resolving its family", async () => {
    // Pins the legacy stored-configuration read: connections configured
    // before write families carry `target_type` rather than
    // `write_family`, and that value must keep deciding what they write
    // until the post-cutover configuration rewrite removes it.
    const { ctx, created, uploads } = buildContext({
      connectionRecord: {
        id: CONNECTION_ID,
        type: "system.connection",
        properties: {
          kind: "integration",
          configuration: {
            target_type: "core.file",
            download_mode: "all-files",
          },
        },
      },
      proxyResponses: [
        () => jsonResponse({ startPageToken: "wp-1" }),
        () =>
          jsonResponse({
            files: [
              {
                id: "drv-pdf3",
                name: "notes.pdf",
                mimeType: "application/pdf",
                size: "8",
                webViewLink: "https://drive.google.com/file/d/drv-pdf3/view",
              },
            ],
          }),
        () => binaryResponse(PDF_BYTES, "application/pdf"),
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    expect(uploads).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("core.file");
  });

  it("skips Google-native files (no per-file activity; rolled into summary)", async () => {
    const { ctx, created, uploads, emitted } = buildContext({
      connectionRecord: allFilesConnectionRecord(),
      proxyResponses: [
        () => jsonResponse({ startPageToken: "wp-1" }),
        () =>
          jsonResponse({
            files: [
              {
                id: "drv-doc",
                name: "Spec.gdoc",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-05-24T01:00:00.000Z",
              },
            ],
          }),
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(uploads).toHaveLength(0);

    // The item lands as google.drive.file (no bytes → no blob_ref).
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("google.drive.file");
    expect(created[0]?.properties?.blob_ref).toBeUndefined();

    // No per-file activity for Google-native (it's a policy, not a failure).
    const perFile = emitted.filter((a) =>
      String(a.properties?.summary).includes("drv-doc"),
    );
    expect(perFile).toHaveLength(0);

    // Roll-up summary counts it.
    const summary = emitted.find((a) =>
      String(a.properties?.summary).includes("download_mode=all-files"),
    );
    expect(String(summary?.properties?.summary)).toContain(
      "skipped_google_native=1",
    );
    expect(String(summary?.properties?.summary)).toContain("files_with_blob=0");

    // Severity stays at `info` — neighbor-integration convention reserves
    // action_required for operator-actionable failures (reauth).
    const actionRequired = emitted.filter(
      (a) => a.properties?.severity === "action_required",
    );
    expect(actionRequired).toHaveLength(0);
  });

  it("skips oversize files at info severity with a per-file detail row", async () => {
    const ceiling = 1024;
    const { ctx, created, uploads, emitted } = buildContext({
      connectionRecord: allFilesConnectionRecord(ceiling),
      proxyResponses: [
        () => jsonResponse({ startPageToken: "wp-1" }),
        () =>
          jsonResponse({
            files: [
              {
                id: "drv-big",
                name: "huge.bin",
                mimeType: "application/octet-stream",
                size: String(ceiling + 1),
                modifiedTime: "2026-05-24T01:00:00.000Z",
              },
            ],
          }),
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(uploads).toHaveLength(0);

    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("google.drive.file");
    expect(created[0]?.properties?.blob_ref).toBeUndefined();

    // Per-file info row mentions the file id + ceiling.
    const perFile = emitted.find((a) =>
      String(a.properties?.summary).includes("oversize"),
    );
    expect(perFile).toBeDefined();
    expect(perFile?.properties?.severity).toBe("info");
    expect(String(perFile?.properties?.summary)).toContain("drv-big");
    expect(perFile?.properties?.detail).toMatchObject({
      drive_file_id: "drv-big",
      ceiling_bytes: ceiling,
    });

    const summary = emitted.find((a) =>
      String(a.properties?.summary).includes("download_mode=all-files"),
    );
    expect(String(summary?.properties?.summary)).toContain("oversize=1");

    // No action_required row for an oversize file.
    const actionRequired = emitted.filter(
      (a) => a.properties?.severity === "action_required",
    );
    expect(actionRequired).toHaveLength(0);
  });

  it("falls back to google.drive.file on per-file download failure (info severity, retry next sync)", async () => {
    const { ctx, created, uploads, emitted } = buildContext({
      connectionRecord: allFilesConnectionRecord(),
      proxyResponses: [
        () => jsonResponse({ startPageToken: "wp-1" }),
        () =>
          jsonResponse({
            files: [
              {
                id: "drv-flaky",
                name: "flaky.bin",
                mimeType: "application/octet-stream",
                size: "16",
                modifiedTime: "2026-05-24T01:00:00.000Z",
              },
            ],
          }),
        // alt=media returns 500
        () => new Response("upstream borked", { status: 500 }),
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(uploads).toHaveLength(0);

    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("google.drive.file");
    expect(created[0]?.properties?.blob_ref).toBeUndefined();

    const perFile = emitted.find((a) =>
      String(a.properties?.summary).includes("download failed for drv-flaky"),
    );
    expect(perFile).toBeDefined();
    expect(perFile?.properties?.severity).toBe("info");

    const summary = emitted.find((a) =>
      String(a.properties?.summary).includes("download_mode=all-files"),
    );
    expect(String(summary?.properties?.summary)).toContain("download_failed=1");
  });

  it("metadata mode (default) emits google.drive.file with blob_ref absent and no synthesized aliases", async () => {
    // No connectionRecord override — defaults to metadata mode.
    const { ctx, created, uploads } = buildContext({
      proxyResponses: [
        () => jsonResponse({ startPageToken: "wp-1" }),
        () =>
          jsonResponse({
            files: [
              {
                id: "drv-md",
                name: "doc.pdf",
                mimeType: "application/pdf",
                size: "100",
                md5Checksum: "should-not-become-blob-ref",
                sha256Checksum: "ditto",
              },
            ],
          }),
        () => jsonResponse({ newStartPageToken: "wp-next", changes: [] }),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(uploads).toHaveLength(0);

    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("google.drive.file");
    expect(created[0]?.properties?.blob_ref).toBeUndefined();
    // The Drive-side checksums are still captured as independent properties.
    expect(created[0]?.properties?.md5_checksum).toBe(
      "should-not-become-blob-ref",
    );
    expect(created[0]?.properties?.sha256_checksum).toBe("ditto");
  });
});
