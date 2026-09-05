import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createApp,
  createSqliteStorage,
  FilesystemBlobBackend,
  BulkActionWorker,
} from "@withmarfa/server";
import { MarfaClient } from "./client.js";
import type { BulkActionFilter } from "./client.js";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";
import type { Item } from "@withmarfa/shared";

let client: MarfaClient;
let testFetchFn: typeof globalThis.fetch;
let adminKey: string;
let cleanup: () => void;

function createTestFetch(app: {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(urlStr);
    return app.request(url.pathname + url.search, init);
  };
}

beforeAll(async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-sdk-test-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"));
  const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: "sqlite",
    sqlitePath: "",
    databaseUrl: "",
    blobPath: "",
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: "test-salt",
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "keys",
    rateLimitEnabled: false,
    enableHsts: false,
    auditRetentionDays: 90,
    auditCleanupIntervalMs: 86_400_000,
    versionThinningIntervalMs: 3_600_000,
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
    versionWeeklySnapshotDays: 365,
    versionMaxVersions: 500,
    trashRetentionDays: 60,
    trashPurgeIntervalMs: 3_600_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:0",
    authAllowSignup: false,
    seedStarterContent: false,
    authSecret: "test-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    mcpEnabled: false,
  });

  testFetchFn = createTestFetch(app);
  const testFetch = testFetchFn;

  const bootstrapRes = await testFetch("http://localhost/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "test-admin",
      source: "sdk-test-admin",
      default_tier: "feed",
    }),
  });
  const { key } = (await bootstrapRes.json()) as { key: string };
  adminKey = key;

  client = new MarfaClient({
    url: "http://localhost",
    apiKey: key,
    fetch: testFetch,
  });

  // Worker must be running for bulkAction() polls to reach terminal state.
  const bulkActionWorker = new BulkActionWorker({
    storage,
    pollIntervalMs: 25,
  });
  await bulkActionWorker.start();

  cleanup = () => {
    bulkActionWorker.stop();
    void storage.close();
  };
});

afterAll(() => {
  cleanup();
});

async function createNote(overrides?: Record<string, unknown>): Promise<Item> {
  return client.items.create({
    type: "core.note",
    properties: { title: "Test note", body: "Content", ...overrides },
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

describe("items", () => {
  it("creates an item", async () => {
    const item = await createNote();
    expect(item.type).toBe("core.note");
    expect(item.version).toBe(1);
    expect(item.state).toBe("active");
    expect(item.id).toBeTruthy();
    expect(item.properties.title).toBe("Test note");
  });

  it("gets an item by id", async () => {
    const created = await createNote();
    const fetched = await client.items.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.properties.title).toBe("Test note");
  });

  it("lists items with filters", async () => {
    await createNote();
    const result = await client.items.list({ type: "core.note", limit: 5 });
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    expect(result).toHaveProperty("has_more");
  });

  it("updates an item", async () => {
    const item = await createNote();
    const updated = await client.items.update(item.id, {
      title: "Updated title",
    });
    expect(updated.properties.title).toBe("Updated title");
    expect(updated.version).toBe(2);
  });

  it("updates with explicit version", async () => {
    const item = await createNote();
    const updated = await client.items.update(
      item.id,
      { title: "V2" },
      { expectedVersion: 1 },
    );
    expect(updated.version).toBe(2);
  });

  it("deletes an item", async () => {
    const item = await createNote();
    await client.items.delete(item.id);
    await expect(client.items.get(item.id)).rejects.toThrow(NotFoundError);
  });

  it("restores a deleted item", async () => {
    const item = await createNote();
    await client.items.delete(item.id);
    const restored = await client.items.restore(item.id);
    expect(restored.state).toBe("active");
  });

  it("transitions item state", async () => {
    const item = await createNote();
    const archived = await client.items.transition(item.id, "archived");
    expect(archived.state).toBe("archived");
  });

  it("gets version history", async () => {
    const item = await createNote();
    await client.items.update(item.id, { title: "V2" });
    const versions = await client.items.versions(item.id);
    expect(versions.length).toBe(1);
    expect(versions[0]?.version).toBe(1);
  });

  it("throws NotFoundError for missing item", async () => {
    await expect(
      client.items.get("00000000-0000-7000-8000-000000000000"),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// items.upsert — natural-key 200/201 surfacing
// ---------------------------------------------------------------------------

describe("items.upsert", () => {
  it("returns created=true on a fresh natural-key insert (HTTP 201)", async () => {
    const sourceId = `upsert-fresh-${Date.now().toString()}`;
    const result = await client.items.upsert({
      type: "core.note",
      properties: { title: "Fresh", body: "First write" },
      source_id: sourceId,
    });
    expect(result.created).toBe(true);
    expect(result.item.properties.title).toBe("Fresh");
    expect(result.item.version).toBe(1);
  });

  it("returns created=false on a natural-key match (HTTP 200, second POST with same source_id)", async () => {
    const sourceId = `upsert-match-${Date.now().toString()}`;

    const first = await client.items.upsert({
      type: "core.note",
      properties: { title: "Initial", body: "v1" },
      source_id: sourceId,
    });
    expect(first.created).toBe(true);

    const second = await client.items.upsert({
      type: "core.note",
      properties: { title: "Updated", body: "v2" },
      source_id: sourceId,
    });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.properties.title).toBe("Updated");
  });

  it("upsert without source_id behaves like create — fresh row each call (created=true)", async () => {
    // No source_id → no natural-key match path → server can never
    // resolve as 200, so created is always true. Caller using upsert
    // without source_id gets the same shape as create plus a redundant
    // boolean — non-broken, documented in JSDoc.
    const a = await client.items.upsert({
      type: "core.note",
      properties: { title: "A", body: "" },
    });
    const b = await client.items.upsert({
      type: "core.note",
      properties: { title: "B", body: "" },
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.item.id).not.toBe(b.item.id);
  });
});

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

describe("conflict resolution", () => {
  it("auto-merges non-conflicting fields", async () => {
    const item = await createNote();

    await client.items.update(
      item.id,
      { title: "Server title" },
      { expectedVersion: 1 },
    );

    // Stale version on a different field — server auto-merges.
    const result = await client.items.update(
      item.id,
      { body: "New body" },
      { expectedVersion: 1 },
    );
    expect(result.properties.title).toBe("Server title");
    expect(result.properties.body).toBe("New body");
  });

  it("auto strategy resolves conflicting fields", async () => {
    const item = await createNote();

    await client.items.update(
      item.id,
      { title: "Server title" },
      { expectedVersion: 1 },
    );

    // Stale version on the same field — a real conflict, resolved by the
    // server. `title` is last-writer-wins and this is the later writer, so
    // it takes this value; the non-conflicting change applies as usual.
    const result = await client.items.update(
      item.id,
      { title: "Client title", body: "Client body" },
      { expectedVersion: 1, conflict: "auto" },
    );
    expect(result.properties.title).toBe("Client title");
    expect(result.properties.body).toBe("Client body");
  });

  it("manual strategy throws ConflictError", async () => {
    const item = await createNote();
    await client.items.update(
      item.id,
      { title: "Server title" },
      { expectedVersion: 1 },
    );

    try {
      await client.items.update(
        item.id,
        { title: "Client title" },
        { expectedVersion: 1, conflict: "manual" },
      );
      expect.fail("Should have thrown ConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      const conflict = err as ConflictError;
      expect(conflict.current.version).toBe(2);
      expect(conflict.conflictingFields).toContain("title");
      expect(conflict.clientPatch).toEqual({ title: "Client title" });
    }
  });

  it("callback strategy uses resolver function", async () => {
    const item = await createNote();
    await client.items.update(
      item.id,
      { title: "Server title" },
      { expectedVersion: 1 },
    );

    const result = await client.items.update(
      item.id,
      { title: "Client title" },
      {
        expectedVersion: 1,
        conflict: "callback",
        resolve: (conflict) => ({
          title: `${String(conflict.current.properties.title)} + ${String(conflict.clientPatch.title)}`,
        }),
      },
    );
    expect(result.properties.title).toBe("Server title + Client title");
  });
});

// ---------------------------------------------------------------------------
// Policy-aware conflict resolution (auto strategy honors merge_policy)
// ---------------------------------------------------------------------------

describe("conflict resolution — policy-aware auto strategy", () => {
  it("core.note body conflict spawns a conflicted-copy sibling", async () => {
    const item = await createNote({ title: "Original title", body: "Base" });
    await client.items.update(
      item.id,
      { body: "Server body" },
      { expectedVersion: 1 },
    );

    const events: string[] = [];
    const result = await client.items.update(
      item.id,
      { body: "Client body" },
      {
        expectedVersion: 1,
        conflict: "auto",
        onAutoMerge: (e) => {
          if (e.conflictedCopyId) events.push(e.conflictedCopyId);
        },
      },
    );

    expect(result.properties.body).toBe("Server body");
    expect(events.length).toBe(1);

    const sibling = await client.items.get(events[0]!);
    expect(sibling.type).toBe("core.note");
    expect(sibling.properties.body).toBe("Client body");
    const meta = await client.metadata.get(events[0]!);
    expect(meta.tags).toContain("conflicted-copy");
  });

  it("core.note title conflict (last-writer-wins) does not spawn a sibling", async () => {
    const item = await createNote();
    await client.items.update(
      item.id,
      { title: "Server title" },
      { expectedVersion: 1 },
    );

    let spawned: string | undefined;
    const result = await client.items.update(
      item.id,
      { title: "Client title" },
      {
        expectedVersion: 1,
        conflict: "auto",
        onAutoMerge: (e) => {
          spawned = e.conflictedCopyId;
        },
      },
    );

    // Last-writer-wins takes the later writer, which is this one. It used
    // to keep the server's value here — first-writer-wins under a name
    // saying the opposite — because the kit resolved it rather than the
    // server.
    expect(result.properties.title).toBe("Client title");
    expect(spawned).toBeUndefined();
  });

  it("core.note mixed conflict (body + title) spawns one sibling for body", async () => {
    const item = await createNote({ title: "Original", body: "Base" });
    await client.items.update(
      item.id,
      { body: "Server body", title: "Server title" },
      { expectedVersion: 1 },
    );

    let event: { conflictedCopyId?: string; fields: string[] } | undefined;
    const result = await client.items.update(
      item.id,
      { body: "Client body", title: "Client title" },
      {
        expectedVersion: 1,
        conflict: "auto",
        onAutoMerge: (e) => {
          event = e;
        },
      },
    );

    expect(result.properties.title).toBe("Client title");
    expect(result.properties.body).toBe("Server body");
    expect(event?.conflictedCopyId).toBeDefined();
    expect(event?.fields.sort()).toEqual(["body", "title"]);

    const sibling = await client.items.get(event!.conflictedCopyId!);
    expect(sibling.properties.body).toBe("Client body");
    // Title is last-writer-wins, so the sibling carries the server's title.
    expect(sibling.properties.title).toBe("Server title");
  });

  it("core.entity.person — no keep-both fields, no sibling spawned", async () => {
    const item = await client.items.create({
      type: "core.entity.person",
      properties: { name: "Alice", given_name: "Alice" },
    });

    await client.items.update(
      item.id,
      { given_name: "Server Alice" },
      { expectedVersion: 1 },
    );

    let spawned: string | undefined;
    const result = await client.items.update(
      item.id,
      { given_name: "Client Alice" },
      {
        expectedVersion: 1,
        conflict: "auto",
        onAutoMerge: (e) => {
          spawned = e.conflictedCopyId;
        },
      },
    );

    expect(result.properties.given_name).toBe("Client Alice");
    expect(spawned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// items.update — expectedVersion skip-GET fast path
// ---------------------------------------------------------------------------

describe("items.update expectedVersion", () => {
  function instrumentFetch(): {
    fetch: typeof globalThis.fetch;
    calls: { method: string; path: string }[];
  } {
    const calls: { method: string; path: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(urlStr);
      calls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
      });
      return testFetchFn(input, init);
    };
    return { fetch, calls };
  }

  function newClient(): {
    client: MarfaClient;
    calls: { method: string; path: string }[];
  } {
    const { fetch, calls } = instrumentFetch();
    const c = new MarfaClient({
      url: "http://localhost",
      apiKey: adminKey,
      fetch,
    });
    return { client: c, calls };
  }

  it("skips the GET when expectedVersion is provided", async () => {
    const item = await createNote();
    const { client: c, calls } = newClient();

    const updated = await c.items.update(
      item.id,
      { title: "Patched" },
      { expectedVersion: item.version },
    );

    expect(updated.version).toBe(item.version + 1);
    const itemCalls = calls.filter((c) => c.path === `/items/${item.id}`);
    expect(itemCalls).toEqual([{ method: "PATCH", path: `/items/${item.id}` }]);
  });

  it("propagates 409 on a stale expectedVersion", async () => {
    const item = await createNote();
    await client.items.update(
      item.id,
      { title: "Server title" },
      { expectedVersion: item.version },
    );

    await expect(
      client.items.update(
        item.id,
        { title: "Client title" },
        { expectedVersion: item.version, conflict: "manual" },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("resolves a keep-both conflict in one request", async () => {
    const item = await createNote({ body: "Base" });
    await client.items.update(
      item.id,
      { body: "Server body" },
      { expectedVersion: 1 },
    );

    const { client: c, calls } = newClient();

    let spawned: string | undefined;
    const result = await c.items.update(
      item.id,
      { body: "Client body" },
      {
        expectedVersion: 1,
        conflict: "auto",
        onAutoMerge: (e) => {
          spawned = e.conflictedCopyId;
        },
      },
    );

    expect(result.properties.body).toBe("Server body");
    // The sibling is still named, but by the server's report rather than by
    // a create the kit performed.
    expect(spawned).toBeDefined();

    // One PATCH and nothing else. The kit used to fetch the type, create the
    // sibling and re-send the update — three more round trips, and no
    // arrangement of them that is atomic.
    expect(calls).toEqual([{ method: "PATCH", path: `/items/${item.id}` }]);
  });

  it("skips the GET when expectedVersion is provided", async () => {
    const item = await createNote();
    const { client: c, calls } = newClient();

    const updated = await c.items.update(
      item.id,
      { title: "Patched" },
      { expectedVersion: item.version },
    );

    expect(updated.version).toBe(item.version + 1);
    const itemCalls = calls.filter((c) => c.path === `/items/${item.id}`);
    expect(itemCalls).toEqual([{ method: "PATCH", path: `/items/${item.id}` }]);
  });

  it("falls back to GET-then-PATCH when no version is provided", async () => {
    const item = await createNote();
    const { client: c, calls } = newClient();

    const updated = await c.items.update(item.id, { title: "Patched" });

    expect(updated.version).toBe(item.version + 1);
    const itemCalls = calls.filter((c) => c.path === `/items/${item.id}`);
    expect(itemCalls[0]).toEqual({ method: "GET", path: `/items/${item.id}` });
    expect(itemCalls[1]).toEqual({
      method: "PATCH",
      path: `/items/${item.id}`,
    });
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("metadata", () => {
  it("gets metadata for an item", async () => {
    const item = await createNote();
    const meta = await client.metadata.get(item.id);
    expect(meta.item_id).toBe(item.id);
    expect(meta.tags).toEqual([]);
  });

  it("sets metadata", async () => {
    const item = await createNote();
    const meta = await client.metadata.set(item.id, {
      tags: ["test", "sdk"],
    });
    expect(meta.tags).toEqual(["test", "sdk"]);
  });

  it("adds tags", async () => {
    const item = await createNote();
    await client.metadata.set(item.id, { tags: ["existing"] });
    const meta = await client.metadata.addTags(item.id, ["new-tag"]);
    expect(meta.tags).toContain("existing");
    expect(meta.tags).toContain("new-tag");
  });

  it("removes a tag", async () => {
    const item = await createNote();
    await client.metadata.set(item.id, { tags: ["keep", "remove"] });
    await client.metadata.removeTag(item.id, "remove");
    const meta = await client.metadata.get(item.id);
    expect(meta.tags).toContain("keep");
    expect(meta.tags).not.toContain("remove");
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe("edges", () => {
  it("exposes edges CRUD + listings via the SDK", async () => {
    const a = await createNote({ title: "A" });
    const b = await createNote({ title: "B" });
    const edge = await client.edges.create({
      source_id: a.id,
      target_id: b.id,
      edge_type: "about",
    });
    expect(edge.edge_type).toBe("about");

    const outbound = await client.items.edges(a.id);
    expect(outbound.data.length).toBe(1);

    const backrefs = await client.items.backrefs(b.id);
    expect(backrefs.data.length).toBe(1);

    await client.edges.delete(edge.id);
    const afterDelete = await client.items.edges(a.id);
    expect(afterDelete.data.length).toBe(0);
  });

  it("supports in-thread edges pointing at any item", async () => {
    const thread = await createNote({ title: "Thread opener" });
    const reply = await createNote({ title: "Thread reply" });
    await client.edges.create({
      source_id: reply.id,
      target_id: thread.id,
      edge_type: "in-thread",
    });

    const members = await client.items.backrefs(thread.id);
    expect(members.data.some((e) => e.source_id === reply.id)).toBe(true);
  });

  it("registers a custom edge type via client.edges.types.create", async () => {
    const schema = await client.edges.types.create({
      id: "sdk.custom-rel",
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "orphan",
      property_schema: {},
    });
    expect(schema.id).toBe("sdk.custom-rel");

    const all = await client.edges.types.list();
    expect(all.some((t) => t.id === "sdk.custom-rel")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("search", () => {
  it("finds items by text content", async () => {
    const item = await client.items.create({
      type: "core.note",
      properties: { title: "Findable note", body: "Searchable body text" },
    });

    const results = await client.search("Findable");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const found = results.find((r) => r.item.id === item.id);
    expect(found).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

describe("blobs", () => {
  it("uploads and downloads a blob", async () => {
    const content = Buffer.from("Hello blob world");
    const { hash } = await client.blobs.upload(content, "text/plain");
    expect(hash).toMatch(/^sha256:/);

    const downloaded = await client.blobs.download(hash);
    const text = Buffer.from(downloaded).toString("utf-8");
    expect(text).toBe("Hello blob world");
  });

  it("checks blob existence", async () => {
    const content = Buffer.from("existence check");
    const { hash } = await client.blobs.upload(content, "text/plain");

    expect(await client.blobs.exists(hash)).toBe(true);
    expect(
      await client.blobs.exists(
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

describe("types", () => {
  it("lists registered types", async () => {
    const types = await client.types.list();
    expect(types.length).toBeGreaterThan(0);
    const noteType = types.find((t) => t.id === "core.note");
    expect(noteType).toBeTruthy();
  });

  it("gets a specific type", async () => {
    const noteType = await client.types.get("core.note");
    expect(noteType.id).toBe("core.note");
    expect(noteType.fields).toHaveProperty("title");
  });

  it("register returns the persisted schema with id and version populated", async () => {
    const id = `demo.t163_${Date.now().toString()}`;
    const registered = await client.types.register({
      id,
      version: 1,
      label: "register-unwrap test",
      description:
        "Ephemeral type proving register() returns the persisted schema",
      fields: {
        name: { type: "string", required: true },
      },
    });
    try {
      expect(registered.id).toBe(id);
      expect(registered.version).toBe(1);
    } finally {
      await client.types.delete(id, { force: true });
    }
  });

  it("update returns the persisted schema with id and version populated", async () => {
    const id = `demo.t167_${Date.now().toString()}`;
    await client.types.register({
      id,
      version: 1,
      label: "update-unwrap test",
      description: "Ephemeral type for the update-unwrap assertion",
      fields: {
        name: { type: "string", required: true },
      },
    });
    try {
      const updated = await client.types.update(id, {
        version: 2,
        label: "update-unwrap test (v2)",
        description: "Updated description on v2",
        fields: {
          name: { type: "string", required: true },
          extra: { type: "string" },
        },
      });
      expect(updated.id).toBe(id);
      expect(updated.version).toBe(2);
    } finally {
      await client.types.delete(id, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe("keys", () => {
  it("creates and lists keys", async () => {
    const { id, key } = await client.keys.create({
      label: "test-key",
      source: "test-key-source",
      role: "member",
    });
    expect(id).toBeTruthy();
    expect(key).toMatch(/^marfa_k1_/);

    const keys = await client.keys.list();
    const found = keys.find((k) => k.id === id);
    expect(found).toBeTruthy();
    expect(found?.label).toBe("test-key");
  });

  it("revokes a key", async () => {
    const { id, key } = await client.keys.create({
      label: "revoke-me",
      source: "revoke-me-source",
      role: "member",
    });
    await client.keys.revoke(id);

    const revokedClient = new MarfaClient({
      url: "http://localhost",
      apiKey: key,
      fetch: testFetchFn,
    });
    await expect(revokedClient.items.list()).rejects.toThrow(UnauthorizedError);
  });

  it("updates a key in place via PATCH", async () => {
    const { id, source } = await client.keys.create({
      label: "update-me",
      source: "update-me-source",
      role: "member",
      default_tier: "feed",
      type_permissions: { "core.note": "read" },
    });

    const updated = await client.keys.update(id, {
      label: "renamed",
      default_tier: "library",
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "read" },
    });

    expect(updated.id).toBe(id);
    expect(updated.source).toBe(source);
    expect(updated.label).toBe("renamed");
    expect(updated.default_tier).toBe("library");
    expect(updated.type_permissions).toEqual({ "core.note": "write" });
    expect(updated.edge_permissions).toEqual({ "*": "read" });
  });

  it("rejects attempts to mutate immutable fields via update", async () => {
    const { id } = await client.keys.create({
      label: "immut-check",
      source: "immut-check-source",
      role: "member",
    });

    // `source` and `role` are intentionally omitted from UpdateKeyInput. The
    // double-cast routes around that to prove the server also rejects them
    // at the wire level — defense in depth.
    await expect(
      client.keys.update(id, {
        source: "renamed-source",
      } as unknown as Parameters<typeof client.keys.update>[1]),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("throws UnauthorizedError with bad key", async () => {
    const badClient = new MarfaClient({
      url: "http://localhost",
      apiKey: "marfa_k1_invalid",
      fetch: testFetchFn,
    });

    await expect(badClient.items.list()).rejects.toThrow(UnauthorizedError);
  });
});

// ---------------------------------------------------------------------------
// Extended SDK surface: library filter, purge, spaces, full keys.create.
// ---------------------------------------------------------------------------

describe("Extended SDK surface", () => {
  it("items.list filters by library", async () => {
    const created = await client.items.create({
      type: "core.note",
      properties: { body: "library marker" },
      tier: "library",
    });
    expect(created.tier).toBe("library");

    const onlyLibrary = await client.items.list({
      type: "core.note",
      tier: "library",
      limit: 200,
    });
    expect(onlyLibrary.data.length).toBeGreaterThan(0);
    for (const item of onlyLibrary.data) {
      expect(item.tier).toBe("library");
    }

    const onlyFeed = await client.items.list({
      type: "core.note",
      tier: "feed",
      limit: 200,
    });
    for (const item of onlyFeed.data) {
      expect(item.tier).toBe("feed");
    }
  });

  it("items.purge hard-deletes a trashed item", async () => {
    const item = await createNote();
    await client.items.delete(item.id);
    await client.items.purge(item.id);
    await expect(client.items.get(item.id)).rejects.toThrow(NotFoundError);
  });

  it("spaces.getConfig returns the empty config in non-space mode", async () => {
    const config = await client.spaces.getConfig();
    expect(typeof config).toBe("object");
  });

  it("spaces.setConfig calls PUT /spaces/me/config", async () => {
    // The test fixture runs in single-space SQLite mode (no space_id on
    // the bootstrap key); the server route rejects PUT under that
    // configuration with a clear validation error. Conformance against a
    // real space-scoped credential is exercised by the conformance suite. Here we
    // just confirm the SDK invokes the endpoint and surfaces the
    // server's response shape.
    await expect(client.spaces.setConfig({})).rejects.toThrow(ValidationError);
  });

  it("keys.create returns the full ApiKey shape including credential defaults", async () => {
    const created = await client.keys.create({
      label: "wave2-sdk-test",
      source: "wave2-sdk-test-src",
      role: "member",
      type_permissions: { "*": "write" },
    });
    expect(created.id).toBeTruthy();
    expect(created.key.startsWith("marfa_k1_")).toBe(true);
    expect(created.label).toBe("wave2-sdk-test");
    expect(created.source).toBe("wave2-sdk-test-src");
    expect(created.role).toBe("member");
    expect(created.default_tier).toBe("library");
    expect(created.type_permissions).toEqual({ "*": "write" });
  });
});

describe("SDK round additions", () => {
  it("metadata.listTags returns distinct tags with counts", async () => {
    await client.items.create({
      type: "core.note",
      properties: { body: "with-tags-a" },
      tags: ["alpha", "beta"],
    });
    await client.items.create({
      type: "core.note",
      properties: { body: "with-tags-b" },
      tags: ["alpha"],
    });
    const tags = await client.metadata.listTags();
    const lookup = new Map(tags.map((t) => [t.tag, t.count]));
    expect(lookup.get("alpha") ?? 0).toBeGreaterThanOrEqual(2);
    expect(lookup.get("beta") ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("edges.list returns global space-scoped edges of a given type", async () => {
    const root = await client.items.create({
      type: "core.note",
      properties: { body: "root" },
    });
    const child = await client.items.create({
      type: "core.note",
      properties: { body: "child" },
    });
    await client.edges.create({
      source_id: root.id,
      target_id: child.id,
      edge_type: "parent-of",
    });
    const result = await client.edges.list({
      edge_type: "parent-of",
      limit: 500,
    });
    const matching = result.data.filter(
      (e) => e.source_id === root.id && e.target_id === child.id,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.edge_type).toBe("parent-of");
  });

  it("search supports tags filter (AND semantics)", async () => {
    const corpusToken = `searchtags-${Math.random().toString(36).slice(2, 8)}`;
    await client.items.create({
      type: "core.note",
      properties: { body: corpusToken },
      tags: ["red", "small"],
    });
    await client.items.create({
      type: "core.note",
      properties: { body: corpusToken },
      tags: ["red", "large"],
    });
    const results = await client.search(corpusToken, {
      tags: ["red", "small"],
      limit: 100,
    });
    expect(results.length).toBe(1);
  });

  it("items.update flips library via UpdateOptions", async () => {
    const item = await client.items.create({
      type: "core.note",
      properties: { body: "lib-flip" },
      tier: "feed",
    });
    expect(item.tier).toBe("feed");
    const updated = await client.items.update(item.id, {}, { tier: "library" });
    expect(updated.tier).toBe("library");
  });
});

// ---------------------------------------------------------------------------
// Bulk operations — items.bulk and items.bulkAction
// ---------------------------------------------------------------------------

describe("items.bulk", () => {
  it("creates items in bulk with counts and per-item results", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const result = await client.items.bulk({
      items: [
        {
          type: "core.note",
          properties: { body: "b1" },
          source_id: `bulk-${suffix}-1`,
        },
        {
          type: "core.note",
          properties: { body: "b2" },
          source_id: `bulk-${suffix}-2`,
        },
      ],
    });
    expect(result.counts.created).toBe(2);
    expect(result.counts.errored).toBe(0);
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.outcome).toBe("created");
      expect(r.id).toBeDefined();
    }
  });

  it("upsert mode updates existing (source, source_id) rows in place", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sourceId = `upsert-${suffix}`;

    const first = await client.items.bulk({
      items: [
        { type: "core.note", properties: { body: "v1" }, source_id: sourceId },
      ],
    });
    const originalId = first.results[0]?.id;
    expect(originalId).toBeDefined();

    const second = await client.items.bulk({
      items: [
        { type: "core.note", properties: { body: "v2" }, source_id: sourceId },
      ],
      mode: "upsert",
    });
    expect(second.counts.updated).toBe(1);
    expect(second.counts.created).toBe(0);
    expect(second.results[0]?.id).toBe(originalId);

    const fetched = await client.items.get(originalId!);
    expect(fetched.properties.body).toBe("v2");
  });

  it("create_only mode surfaces matches as skipped", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sourceId = `co-${suffix}`;

    await client.items.bulk({
      items: [
        { type: "core.note", properties: { body: "v1" }, source_id: sourceId },
      ],
      mode: "create_only",
    });

    const second = await client.items.bulk({
      items: [
        {
          type: "core.note",
          properties: { body: "nope" },
          source_id: sourceId,
        },
      ],
      mode: "create_only",
    });
    expect(second.counts.skipped).toBe(1);
    expect(second.counts.created).toBe(0);
    expect(second.results[0]?.outcome).toBe("skipped");
    expect(second.results[0]?.reason).toBe("duplicate_source");
  });

  it("atomic=true rolls back the whole batch on validation error", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const tag = `atomic-${suffix}`;

    await expect(
      client.items.bulk({
        items: [
          {
            type: "core.note",
            properties: { body: "good" },
            tags: [tag],
            source_id: `${tag}-good`,
          },
          {
            type: "NOT a valid type id",
            properties: {},
            tags: [tag],
            source_id: `${tag}-bad`,
          },
        ],
        atomic: true,
      }),
    ).rejects.toMatchObject({
      code: "bulk_atomic_rollback",
    });

    const list = await client.items.list({ tags: [tag] });
    expect(list.data).toHaveLength(0);
  });

  it("atomic=false returns per-item error entries without throwing", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const result = await client.items.bulk({
      items: [
        {
          type: "core.note",
          properties: { body: "ok" },
          source_id: `nonatomic-${suffix}-1`,
        },
        {
          type: "NOT a valid type",
          properties: {},
          source_id: `nonatomic-${suffix}-bad`,
        },
      ],
      atomic: false,
    });
    expect(result.counts.created).toBe(1);
    expect(result.counts.errored).toBe(1);
    expect(result.results[1]?.outcome).toBe("errored");
    expect(result.results[1]?.error?.code).toBe("invalid_type");
  });

  it("supports inline edges on bulk create", async () => {
    const target = await client.items.create({
      type: "core.entity",
      properties: { name: "edge target" },
    });

    const suffix = Math.random().toString(36).slice(2, 8);
    const result = await client.items.bulk({
      items: [
        {
          type: "core.note",
          properties: { body: "with edges" },
          source_id: `inline-${suffix}`,
          edges: { about: [target.id] },
        },
      ],
    });
    const createdId = result.results[0]?.id;
    expect(createdId).toBeDefined();

    const edges = await client.items.edges(createdId!, {
      edge_type: "about",
    });
    expect(edges.data.map((e) => e.target_id)).toContain(target.id);
  });
});

// ---------------------------------------------------------------------------
// items.createWithAttachments
// ---------------------------------------------------------------------------

describe("items.createWithAttachments", () => {
  const PNG_BYTES = new Uint8Array([1, 2, 3, 4]);
  const JPG_BYTES = new Uint8Array([5, 6, 7, 8]);

  /**
   * Build a fresh client backed by a fetch wrapper that counts `/blobs`
   * POSTs and `/items/bulk` POSTs and can be told to fail the Nth blob
   * upload. Used by the partial-failure test to assert that bulk is not
   * issued when an upload throws.
   */
  function makeInstrumentedClient(opts: { failBlobUploadAtIndex?: number }) {
    const counts = { blobPosts: 0, bulkPosts: 0 };
    const wrapped: typeof globalThis.fetch = async (input, init) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method?.toUpperCase() ?? "GET";
      if (method === "POST" && urlStr.endsWith("/blobs")) {
        const idx = counts.blobPosts;
        counts.blobPosts++;
        if (idx === opts.failBlobUploadAtIndex) {
          return new Response(
            JSON.stringify({ error: "synthetic", message: "boom" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      if (method === "POST" && urlStr.endsWith("/items/bulk")) {
        counts.bulkPosts++;
      }
      return testFetchFn(input, init);
    };
    const c = new MarfaClient({
      url: "http://localhost",
      apiKey: adminKey,
      fetch: wrapped,
    });
    return { client: c, counts };
  }

  it("happy path — creates host note + two file attachments wired by attached-to edges", async () => {
    const result = await client.items.createWithAttachments({
      item: {
        type: "core.note",
        properties: { title: "Note with attachments", body: "hello" },
      },
      attachments: [
        { type: "core.file", blob: PNG_BYTES, mimeType: "image/png" },
        { type: "core.file", blob: JPG_BYTES, mimeType: "image/jpeg" },
      ],
    });

    expect(result.host.type).toBe("core.note");
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]!.type).toBe("core.file");
    expect(result.attachments[1]!.type).toBe("core.file");

    expect(
      (result.attachments[0]!.properties as { mime_type: string }).mime_type,
    ).toBe("image/png");
    expect(
      (result.attachments[1]!.properties as { mime_type: string }).mime_type,
    ).toBe("image/jpeg");

    expect(
      (result.attachments[0]!.properties as { blob_ref: string }).blob_ref,
    ).toMatch(/^sha256:[a-f0-9]+$/);
    expect(
      (result.attachments[1]!.properties as { blob_ref: string }).blob_ref,
    ).toMatch(/^sha256:[a-f0-9]+$/);

    for (const att of result.attachments) {
      const edges = await client.items.edges(att.id, {
        edge_type: "attached-to",
      });
      expect(edges.data.map((e) => e.target_id)).toEqual([result.host.id]);
    }
  });

  it("partial-upload failure — throws and does NOT issue the bulk call", async () => {
    const { client: instrumented, counts } = makeInstrumentedClient({
      failBlobUploadAtIndex: 1,
    });

    await expect(
      instrumented.items.createWithAttachments({
        item: {
          type: "core.note",
          properties: { title: "should not be created" },
        },
        attachments: [
          { type: "core.file", blob: PNG_BYTES, mimeType: "image/png" },
          { type: "core.file", blob: JPG_BYTES, mimeType: "image/jpeg" },
        ],
      }),
    ).rejects.toThrow(/attachments\[1\]/);

    // The failed upload short-circuits the helper. Bulk must not be issued.
    expect(counts.bulkPosts).toBe(0);
  });

  it("explicit host id — uses caller-provided id as host id and edge target", async () => {
    const explicitId = "01900000-0000-7000-8000-deadbeef0100";
    const result = await client.items.createWithAttachments({
      item: {
        id: explicitId,
        type: "core.note",
        properties: { body: "explicit-id host" },
      },
      attachments: [
        { type: "core.file", blob: PNG_BYTES, mimeType: "image/png" },
      ],
    });

    expect(result.host.id).toBe(explicitId);
    const edges = await client.items.edges(result.attachments[0]!.id, {
      edge_type: "attached-to",
    });
    expect(edges.data.map((e) => e.target_id)).toEqual([explicitId]);
  });

  it("caller-supplied host edges co-exist with helper auto-edges in the same atomic bulk call", async () => {
    // Pre-seed an `about` target item that the host will reference. Same
    // atomic bulk call writes (host + attachment); the host carries the
    // caller's `about` edge to the pre-existing target, and the
    // attachment carries the helper-added `attached-to` edge to the host.
    const aboutTarget = await client.items.create({
      type: "core.entity",
      properties: { name: "about target" },
    });

    const result = await client.items.createWithAttachments({
      item: {
        type: "core.note",
        properties: { body: "host with about edge" },
        edges: { about: [aboutTarget.id] },
      },
      attachments: [
        { type: "core.file", blob: PNG_BYTES, mimeType: "image/png" },
      ],
    });

    // Host carries the caller's `about` edge — unchanged.
    const hostAbout = await client.items.edges(result.host.id, {
      edge_type: "about",
    });
    expect(hostAbout.data.map((e) => e.target_id)).toEqual([aboutTarget.id]);

    // Attachment carries the helper's `attached-to` edge — co-existing,
    // not replaced.
    const attEdges = await client.items.edges(result.attachments[0]!.id, {
      edge_type: "attached-to",
    });
    expect(attEdges.data.map((e) => e.target_id)).toEqual([result.host.id]);
  });

  it("caller-supplied edges on the same edgeType key are additively merged — never replaced", async () => {
    // Pre-seed an extra `attached-to` target the caller wants to keep.
    // The helper must append the host id to the caller's array, not
    // overwrite it.
    const extraTarget = await client.items.create({
      type: "core.note",
      properties: { body: "pre-existing attachment target" },
    });

    const result = await client.items.createWithAttachments({
      item: {
        type: "core.note",
        properties: { body: "host" },
      },
      attachments: [
        {
          type: "core.file",
          blob: PNG_BYTES,
          mimeType: "image/png",
          edges: { "attached-to": [extraTarget.id] },
        },
      ],
    });

    const attEdges = await client.items.edges(result.attachments[0]!.id, {
      edge_type: "attached-to",
    });
    const targets = attEdges.data.map((e) => e.target_id).sort();
    expect(targets).toEqual([extraTarget.id, result.host.id].sort());
  });

  it("explicit host id collision throws — `mode: create_only` skip becomes a MarfaError", async () => {
    // Seed an item with an explicit id, then try to use the same id as
    // the host id in createWithAttachments. The bulk call returns
    // `outcome: "skipped"` for the host; the helper must surface that
    // as a thrown MarfaError rather than silently returning the
    // pre-existing item.
    const seedId = "01900000-0000-7000-8000-deadbeef0200";
    await client.items.create({
      id: seedId,
      type: "core.note",
      properties: { body: "pre-existing host" },
    });

    await expect(
      client.items.createWithAttachments({
        item: {
          id: seedId,
          type: "core.note",
          properties: { body: "would-be fresh host" },
        },
        attachments: [],
      }),
    ).rejects.toThrow(/duplicate_id|requires fresh ids/);
  });

  it("empty attachments array — issues bulk with just the host, no blob uploads, no auto-edges", async () => {
    const { client: instrumented, counts } = makeInstrumentedClient({});

    const result = await instrumented.items.createWithAttachments({
      item: {
        type: "core.note",
        properties: { body: "no attachments here" },
      },
      attachments: [],
    });

    expect(result.host.type).toBe("core.note");
    expect(result.attachments).toEqual([]);
    expect(counts.blobPosts).toBe(0);
    expect(counts.bulkPosts).toBe(1);
  });
});

describe("items.bulkAction", () => {
  async function seedTagged(count: number, tag: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = await client.items.create({
        type: "core.note",
        properties: { body: `seed-${String(i)}` },
        tags: [tag],
      });
      ids.push(item.id);
    }
    return ids;
  }

  it("transition action archives every match", async () => {
    const tag = `ba-trans-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seedTagged(3, tag);

    const result = await client.items.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(3);
    expect(result.errored).toBe(0);

    const fetched = await client.items.get(ids[0]!);
    expect(fetched.state).toBe("archived");
  });

  it("dry_run returns matched ids and succeeded=0", async () => {
    const tag = `ba-dry-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seedTagged(2, tag);

    const result = await client.items.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
      dry_run: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.ids?.sort()).toEqual(ids.slice().sort());

    const fetched = await client.items.get(ids[0]!);
    expect(fetched.state).toBe("active");
  });

  it("purge action removes matching items (with confirm)", async () => {
    const tag = `ba-purge-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seedTagged(2, tag);

    const result = await client.items.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(2);
    expect(result.blob_hashes_referenced).toBeDefined();

    await expect(client.items.get(ids[0]!)).rejects.toThrow(NotFoundError);
  });

  it("purge without confirm throws client-side before sending", async () => {
    // Cast to bypass the compiler — this is the JS-caller path where
    // the literal is dropped at runtime.
    const bad = {
      action: "purge",
      filter: { type: "core.note" },
    } as unknown as Parameters<typeof client.items.bulkAction>[0];

    await expect(client.items.bulkAction(bad)).rejects.toMatchObject({
      code: "bulk_confirmation_required",
    });
  });

  it("update_tags adds and removes on every match", async () => {
    const tag = `ba-tags-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seedTagged(2, tag);

    const result = await client.items.bulkAction({
      action: "update_tags",
      add: [`${tag}-added`],
      remove: [tag],
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(2);

    const md = await client.metadata.get(ids[0]!);
    expect(md.tags).toContain(`${tag}-added`);
    expect(md.tags).not.toContain(tag);
  });

  it("update_tier, update_properties, update_timestamp all land", async () => {
    const tag = `ba-multi-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seedTagged(1, tag);

    await client.items.bulkAction({
      action: "update_tier",
      tier: "feed",
      filter: { tags: [tag] },
    });
    await client.items.bulkAction({
      action: "update_properties",
      patch: { extra_bulk: "patched" },
      filter: { tags: [tag] },
    });
    const iso = "2001-09-11T08:46:00.000Z";
    await client.items.bulkAction({
      action: "update_timestamp",
      timestamp: iso,
      filter: { tags: [tag] },
    });

    const fetched = await client.items.get(ids[0]!);
    expect(fetched.tier).toBe("feed");
    expect((fetched.properties as { extra_bulk?: string }).extra_bulk).toBe(
      "patched",
    );
    expect(fetched.timestamp).toBe(iso);
  });

  it("max_items cap exceeded surfaces as bulk_cap_exceeded", async () => {
    const tag = `ba-cap-${Math.random().toString(36).slice(2, 8)}`;
    await seedTagged(5, tag);

    await expect(
      client.items.bulkAction({
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
        max_items: 2,
      }),
    ).rejects.toMatchObject({
      code: "bulk_cap_exceeded",
    });
  });

  it("filter.state and filter.tier stay narrower than GET /items — the route has no revoked-state or all-tier match", () => {
    // The assertion here is the compile step, not a runtime expectation.
    // Each `@ts-expect-error` fails the build the moment the error it
    // names stops happening, which is exactly what widening the field
    // back would do. Types are erased before this body runs, so no
    // runtime check on these values can distinguish a narrowed type from
    // a wide one — the sibling test below is what holds the server's
    // half. This one goes red under `typecheck` rather than under the
    // test runner.
    // @ts-expect-error — `revoked` is a system.*-only lifecycle value;
    // POST /items/bulk-actions filters over the ordinary three-state
    // lifecycle only, so this must not typecheck.
    const rejectedState: BulkActionFilter = { state: "revoked" };
    // @ts-expect-error — the bulk-action route has no `"all"` catch-all
    // on tier; that only exists on GET /items' wider ListFilters.
    const rejectedTier: BulkActionFilter = { tier: "all" };

    // The other half, so this pins a narrowing to exactly two values
    // rather than to anything narrower: both of these must still assign.
    const acceptedState: BulkActionFilter = { state: "trashed" };
    const acceptedTier: BulkActionFilter = { tier: "library" };

    void [rejectedState, rejectedTier, acceptedState, acceptedTier];
  });

  it("the server refuses tier: all, and quietly matches nothing for state: revoked", async () => {
    const tag = `ba-narrow-${Math.random().toString(36).slice(2, 8)}`;
    await seedTagged(1, tag);
    const base = {
      action: "transition" as const,
      state: "archived" as const,
      dry_run: true,
    };

    // The control, so the two below are read against a filter that does
    // match. Without it a zero could mean the tag never landed.
    await expect(
      client.items.bulkAction({ ...base, filter: { tags: [tag] } }),
    ).resolves.toMatchObject({ matched: 1 });

    // `tier` is still refused, which is the straightforward half: the
    // route has no `"all"` catch-all, and says so.
    await expect(
      client.items.bulkAction({
        ...base,
        filter: { tags: [tag], tier: "all" } as unknown as BulkActionFilter,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    // `state` is the half that changed, and it changed in the direction
    // that makes the narrowing above matter more rather than less. The
    // route used to refuse an unrecognized lifecycle value; it now takes
    // it, applies it, and matches nothing. So a caller who types a state
    // the bulk door does not have gets a clean answer saying zero rows
    // were affected, which is indistinguishable from a filter that is
    // correct and simply selects nothing.
    //
    // Nothing is destroyed by that — the actions are transition, tag and
    // delete, and all three are no-ops over an empty match — but the
    // typo survives, and the type is now the only thing that catches it.
    await expect(
      client.items.bulkAction({
        ...base,
        filter: {
          tags: [tag],
          state: "revoked",
        } as unknown as BulkActionFilter,
      }),
    ).resolves.toMatchObject({ matched: 0, succeeded: 0, errored: 0 });
  });
});

describe("edges.bulk", () => {
  async function makePair(): Promise<{ sourceId: string; targetId: string }> {
    const source = await client.items.create({
      type: "core.note",
      properties: { body: "source" },
    });
    const target = await client.items.create({
      type: "core.entity",
      properties: { name: "target" },
    });
    return { sourceId: source.id, targetId: target.id };
  }

  it("creates edges in bulk with counts and per-edge results", async () => {
    const a = await makePair();
    const b = await makePair();

    const result = await client.edges.bulk({
      edges: [
        {
          source_id: a.sourceId,
          target_id: a.targetId,
          edge_type: "about",
        },
        {
          source_id: b.sourceId,
          target_id: b.targetId,
          edge_type: "about",
        },
      ],
    });
    expect(result.counts.created).toBe(2);
    expect(result.counts.errored).toBe(0);
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.outcome).toBe("created");
      expect(r.id).toBeDefined();
    }
  });

  it("upsert mode replaces properties on existing triples", async () => {
    const { sourceId, targetId } = await makePair();

    const first = await client.edges.bulk({
      edges: [
        {
          source_id: sourceId,
          target_id: targetId,
          edge_type: "about",
          properties: { weight: 1 },
        },
      ],
    });
    const originalId = first.results[0]?.id;
    expect(originalId).toBeDefined();

    const second = await client.edges.bulk({
      edges: [
        {
          source_id: sourceId,
          target_id: targetId,
          edge_type: "about",
          properties: { weight: 99 },
        },
      ],
      mode: "upsert",
    });
    expect(second.counts.updated).toBe(1);
    expect(second.counts.created).toBe(0);
    expect(second.results[0]?.id).toBe(originalId);

    const outbound = await client.edges.listFromSource(sourceId, {
      edge_type: "about",
    });
    const hit = outbound.data.find((e) => e.id === originalId);
    expect(hit?.properties.weight).toBe(99);
  });

  it("create_only surfaces duplicates as skipped with reason duplicate_edge", async () => {
    const { sourceId, targetId } = await makePair();

    await client.edges.bulk({
      edges: [{ source_id: sourceId, target_id: targetId, edge_type: "about" }],
      mode: "create_only",
    });

    const second = await client.edges.bulk({
      edges: [
        {
          source_id: sourceId,
          target_id: targetId,
          edge_type: "about",
          properties: { nope: true },
        },
      ],
      mode: "create_only",
    });
    expect(second.counts.skipped).toBe(1);
    expect(second.counts.created).toBe(0);
    expect(second.results[0]?.outcome).toBe("skipped");
    expect(second.results[0]?.reason).toBe("duplicate_edge");
  });

  it("atomic=true rolls back the whole batch on error", async () => {
    const a = await makePair();

    await expect(
      client.edges.bulk({
        edges: [
          {
            source_id: a.sourceId,
            target_id: a.targetId,
            edge_type: "about",
          },
          {
            source_id: a.sourceId,
            target_id: "not-a-valid-id",
            edge_type: "about",
          },
        ],
        atomic: true,
      }),
    ).rejects.toMatchObject({ code: "bulk_atomic_rollback" });

    const edges = await client.edges.listFromSource(a.sourceId, {
      edge_type: "about",
    });
    expect(edges.data).toHaveLength(0);
  });

  it("atomic=false returns per-edge errors without throwing", async () => {
    const a = await makePair();
    const b = await makePair();

    const result = await client.edges.bulk({
      edges: [
        { source_id: a.sourceId, target_id: a.targetId, edge_type: "about" },
        {
          source_id: a.sourceId,
          target_id: "not-a-valid-id",
          edge_type: "about",
        },
        { source_id: b.sourceId, target_id: b.targetId, edge_type: "about" },
      ],
      atomic: false,
    });
    expect(result.counts.created).toBe(2);
    expect(result.counts.errored).toBe(1);
    expect(result.results[1]?.outcome).toBe("errored");
    expect(result.results[1]?.error?.code).toBe("invalid_id");
  });
});
