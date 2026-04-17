import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createApp,
  createSqliteStorage,
  FilesystemBlobBackend,
} from "@mymehq/server";
import { MymeClient } from "./client.js";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";
import type { Item } from "@mymehq/shared";

// ---------------------------------------------------------------------------
// Test setup: create a real Hono app, bootstrap an admin key, create SDK client
// ---------------------------------------------------------------------------

let client: MymeClient;
let testFetchFn: typeof globalThis.fetch;
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
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-sdk-test-"));
  const storage = createSqliteStorage(join(tmpDir, "test.db"));
  const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: "sqlite",
    sqlitePath: "",
    databaseUrl: "",
    blobPath: "",
    blobBackend: "fs",
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: "test-salt",
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "keys",
    versionSnapshotIntervalMs: 600_000,
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
    ambientRetentionDays: 0,
    ambientExpiryIntervalMs: 3_600_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
  });

  testFetchFn = createTestFetch(app);
  const testFetch = testFetchFn;

  // Bootstrap: create first admin key (no auth required)
  const bootstrapRes = await testFetch("http://localhost/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "test-admin",
      source: "sdk-test-admin",
      default_library: false,
    }),
  });
  const { key } = (await bootstrapRes.json()) as { key: string };

  client = new MymeClient({
    url: "http://localhost",
    apiKey: key,
    fetch: testFetch,
  });

  cleanup = () => {
    void storage.close();
  };
});

afterAll(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

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
      { version: 1 },
    );
    expect(updated.version).toBe(2);
  });

  it("deletes an item", async () => {
    const item = await createNote();
    await client.items.delete(item.id);
    // Trashed items return 404 on GET
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
// Conflict resolution
// ---------------------------------------------------------------------------

describe("conflict resolution", () => {
  it("auto-merges non-conflicting fields", async () => {
    const item = await createNote();

    // First update changes title
    await client.items.update(
      item.id,
      { title: "Server title" },
      { version: 1 },
    );

    // Second update changes body with stale version — server auto-merges
    const result = await client.items.update(
      item.id,
      { body: "New body" },
      { version: 1 },
    );
    expect(result.properties.title).toBe("Server title");
    expect(result.properties.body).toBe("New body");
  });

  it("auto strategy resolves conflicting fields", async () => {
    const item = await createNote();

    // First update changes title
    await client.items.update(
      item.id,
      { title: "Server title" },
      { version: 1 },
    );

    // Second update also changes title with stale version — real conflict
    // Auto strategy: server's title wins, but non-conflicting changes preserved
    const result = await client.items.update(
      item.id,
      { title: "Client title", body: "Client body" },
      { version: 1, conflict: "auto" },
    );
    // After auto-merge: title = server's value, body = client's value
    expect(result.properties.title).toBe("Server title");
    expect(result.properties.body).toBe("Client body");
  });

  it("manual strategy throws ConflictError", async () => {
    const item = await createNote();
    await client.items.update(
      item.id,
      { title: "Server title" },
      { version: 1 },
    );

    try {
      await client.items.update(
        item.id,
        { title: "Client title" },
        { version: 1, conflict: "manual" },
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
      { version: 1 },
    );

    const result = await client.items.update(
      item.id,
      { title: "Client title" },
      {
        version: 1,
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
    expect(key).toMatch(/^myme_k1_/);

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

    // Revoked key should no longer authenticate
    const revokedClient = new MymeClient({
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
      default_origin: "user",
      default_library: false,
      type_permissions: { "core.note": "read" },
    });

    const updated = await client.keys.update(id, {
      label: "renamed",
      default_library: true,
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "read" },
    });

    expect(updated.id).toBe(id);
    // source stays put — it's immutable
    expect(updated.source).toBe(source);
    expect(updated.label).toBe("renamed");
    expect(updated.default_library).toBe(true);
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
    const badClient = new MymeClient({
      url: "http://localhost",
      apiKey: "myme_k1_invalid",
      fetch: testFetchFn,
    });

    await expect(badClient.items.list()).rejects.toThrow(UnauthorizedError);
  });
});

// ---------------------------------------------------------------------------
// Extended SDK surface: library filter, purge, tenants, full keys.create.
// ---------------------------------------------------------------------------

describe("Extended SDK surface", () => {
  it("items.list filters by library", async () => {
    const created = await client.items.create({
      type: "core.note",
      properties: { body: "library marker" },
      library: true,
    });
    expect(created.library).toBe(true);

    const onlyLibrary = await client.items.list({
      type: "core.note",
      library: true,
      limit: 200,
    });
    expect(onlyLibrary.data.length).toBeGreaterThan(0);
    for (const item of onlyLibrary.data) {
      expect(item.library).toBe(true);
    }

    const onlyAmbient = await client.items.list({
      type: "core.note",
      library: false,
      limit: 200,
    });
    for (const item of onlyAmbient.data) {
      expect(item.library).toBe(false);
    }
  });

  it("items.purge hard-deletes a trashed item", async () => {
    const item = await createNote();
    await client.items.delete(item.id);
    await client.items.purge(item.id);
    await expect(client.items.get(item.id)).rejects.toThrow(NotFoundError);
  });

  it("tenants.getConfig returns the empty config in non-tenant mode", async () => {
    const config = await client.tenants.getConfig();
    expect(typeof config).toBe("object");
  });

  it("tenants.setConfig calls PUT /tenants/current/config", async () => {
    // The test fixture runs in single-tenant SQLite mode (no tenant_id on
    // the bootstrap key); the server route rejects PUT under that
    // configuration with a clear validation error. Conformance against a
    // real tenant-scoped credential is exercised by mock-myme. Here we
    // just confirm the SDK invokes the endpoint and surfaces the
    // server's response shape.
    await expect(client.tenants.setConfig({})).rejects.toThrow(ValidationError);
  });

  it("keys.create returns the full ApiKey shape including credential defaults", async () => {
    const created = await client.keys.create({
      label: "wave2-sdk-test",
      source: "wave2-sdk-test-src",
      role: "member",
      type_permissions: { "*": "write" },
    });
    expect(created.id).toBeTruthy();
    expect(created.key.startsWith("myme_k1_")).toBe(true);
    expect(created.label).toBe("wave2-sdk-test");
    expect(created.source).toBe("wave2-sdk-test-src");
    expect(created.role).toBe("member");
    expect(created.default_origin).toBe("user");
    expect(created.default_library).toBe(false);
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

  it("edges.list returns global tenant-scoped edges of a given type", async () => {
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
      library: false,
    });
    expect(item.library).toBe(false);
    const updated = await client.items.update(item.id, {}, { library: true });
    expect(updated.library).toBe(true);
  });
});
