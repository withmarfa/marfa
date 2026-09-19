import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureBootstrapSecret,
  createApp,
  createSqliteStorage,
  ensureInstanceId,
  FilesystemBlobBackend,
  BulkActionWorker,
} from "@withmarfa/server";
import { MarfaClient } from "./client.js";
import { collect } from "./pagination.js";
import type { BulkActionFilter, BulkActionInput } from "./client.js";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";
import type { Storage } from "@withmarfa/server";
import type { Item } from "@withmarfa/shared";

let client: MarfaClient;
let testFetchFn: typeof globalThis.fetch;
let workingKey: string;
let testStorage: Storage;
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
  testStorage = storage;
  const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
  const instanceId = await ensureInstanceId(storage.settings);
  const app = createApp(
    storage,
    blobBackend,
    {
      port: 0,
      sqlitePath: "",
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
      authSecret: "test-secret",
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
    },
    instanceId,
  );

  testFetchFn = createTestFetch(app);
  const testFetch = testFetchFn;

  // **The first mint produces the operator key**, which holds no permission:
  // running the instance sits outside the model. It is not a working key, so
  // the fixture uses it to mint one, which is the setup bootstrap is meant to
  // follow.
  //
  // It presents the one-time secret the server prints to its boot log, because
  // that call is the product's one unauthenticated write and is bound to
  // whoever runs the instance. This fixture boots the app in-process and never
  // reads a log, so it obtains the secret the way boot does.
  const bootstrapSecret = await ensureBootstrapSecret(storage);
  const bootstrapRes = await testFetch("http://localhost/keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bootstrapSecret}`,
    },
    body: JSON.stringify({
      label: "test-operator",
      source: "sdk-test-operator",
      default_tier: "feed",
    }),
  });
  // Bootstrap hands back the operator key, which is not a working key; the
  // operator mints one through the same door, and a body naming nothing takes
  // everything. The fixture runs as that working key, which is the setup keys
  // mode is meant to follow.
  const bootstrap = (await bootstrapRes.json()) as { key: string };
  const workingRes = await testFetch("http://localhost/keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bootstrap.key}`,
    },
    body: JSON.stringify({
      label: "test-working",
      source: "sdk-test",
      default_tier: "library",
    }),
  });
  if (workingRes.status !== 201) {
    throw new Error(
      `working key mint answered ${String(workingRes.status)}: ${await workingRes.text()}`,
    );
  }
  const key = ((await workingRes.json()) as { key: string }).key;
  workingKey = key;

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

describe("a 409 the update path does not resolve", () => {
  it("refuses rather than resolving with no item", async () => {
    // `PATCH /items/{id}` publishes three `409` shapes: a version
    // conflict, an ancestor that cannot be merged against, and an
    // ordinary error envelope carrying `source_id_conflict` or
    // `type_mismatch`.
    //
    // The transport hands every `409` body back unchanged rather than
    // throwing, so reading "not the first, not the second, therefore
    // success" takes the third for a resolved update and returns its
    // absent `item`. A refusal then arrives as a resolved promise carrying
    // `undefined` where the signature promises an `Item` — so a caller that
    // decides a write landed by the absence of a throw is told the server
    // accepted what it refused.
    const first = await client.items.create({
      type: "core.note",
      properties: { body: "first" },
      source_id: "collide-a",
    });
    await client.items.create({
      type: "core.note",
      properties: { body: "second" },
      source_id: "collide-b",
    });

    await expect(
      client.items.update(
        first.id,
        { body: "moved" },
        { source_id: "collide-b" },
      ),
    ).rejects.toMatchObject({ code: "source_id_conflict", status: 409 });
  });
});

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
      apiKey: workingKey,
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
    });

    // `source` is intentionally omitted from UpdateKeyInput. The double-cast
    // routes around that to prove the server also rejects it at the wire
    // level — defense in depth.
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
// Extended SDK surface: library filter, purge, instance config, full keys.create.
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

  it("config.get names the instance", async () => {
    const config = await client.config.get();
    expect(typeof config.instance_id).toBe("string");
  });

  it("config.set calls PUT /config and takes the document back", async () => {
    // What this asserts is that the SDK reaches the door and returns the
    // config the server sent back, not merely that it built a request.
    const identity = (await client.config.get()).instance_id;
    await expect(client.config.set({})).resolves.toEqual({
      instance_id: identity,
    });
    // And that the whole document `get` returns is a body `set` takes: the
    // identity is in every read, so a caller reading, editing and writing
    // back would be refused if the SDK stripped it or the door rejected it.
    await expect(
      client.config.set({ instance_id: identity, audit_retention_days: 21 }),
    ).resolves.toEqual({ instance_id: identity, audit_retention_days: 21 });
    await client.config.set({});
  });

  it("keys.create returns the full ApiKey shape including credential defaults", async () => {
    const created = await client.keys.create({
      label: "wave2-sdk-test",
      source: "wave2-sdk-test-src",
      type_permissions: { "*": "write" },
    });
    expect(created.id).toBeTruthy();
    expect(created.key.startsWith("marfa_k1_")).toBe(true);
    expect(created.label).toBe("wave2-sdk-test");
    expect(created.source).toBe("wave2-sdk-test-src");
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

  it("edges.list returns every edge of a given type", async () => {
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
    expect(result.results[1]?.error?.code).toBe("validation_error");
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
      apiKey: workingKey,
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

  /**
   * A client whose status polls misbehave on the way in, while the job
   * itself runs normally on the server.
   *
   * This is the distinction the bug turned on: the job being long and the
   * question about it being slow are different things, and only the second
   * one used to be reported as a failure. Faking a slow job would prove
   * nothing about it.
   */
  function clientWithFailingStatusPolls(failures: number): {
    client: MarfaClient;
    polls: () => number;
  } {
    let seen = 0;
    const made = new MarfaClient({
      url: "http://localhost",
      apiKey: workingKey,
      fetch: (input, init) => {
        const url = String(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.includes("/items/bulk-actions/jobs/")) {
          seen += 1;
          if (seen <= failures) {
            // What a timed-out request looks like at this seam: the
            // transport turns an abort into MarfaError('timeout').
            return Promise.reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          }
        }
        return testFetchFn(input, init);
      },
    });
    return { client: made, polls: () => seen };
  }

  /** A client whose status polls answer with a given HTTP response for the
   *  first `count` attempts, then behave normally. Returns the client and a
   *  counter, so a test can assert how many polls a failure shape cost. */
  function clientWithStatusResponse(
    count: number,
    make: () => Response,
  ): { client: MarfaClient; polls: () => number } {
    let seen = 0;
    const made = new MarfaClient({
      url: "http://localhost",
      apiKey: workingKey,
      fetch: (input, init) => {
        const url = String(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.includes("/items/bulk-actions/jobs/")) {
          seen += 1;
          if (seen <= count) return Promise.resolve(make());
        }
        return testFetchFn(input, init);
      },
    });
    return { client: made, polls: () => seen };
  }

  it("waits out a gateway 5xx whose body is not the server's JSON envelope", async () => {
    // The shape a 502 or 503 actually takes in front of a loaded instance: an
    // HTML error page from something that is not the app. The transport parses
    // the body before it checks `ok`, so this arrives as `parse_error` with
    // `status: 0` and the real code only in `details.httpStatus` — and a
    // retry rule reading `status` alone misses the most likely 5xx there is.
    const tag = `ba-gateway-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seedTagged(1, tag);

    const { client: flaky } = clientWithStatusResponse(
      2,
      () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await flaky.items.bulkAction(
      { action: "transition", state: "archived", filter: { tags: [tag] } },
      { pollIntervalMs: 10, maxPollIntervalMs: 20 },
    );

    expect(result.succeeded).toBe(1);
    expect((await client.items.get(ids[0]!)).state).toBe("archived");
  });

  it("waits out a 429 rather than reporting the job failed", async () => {
    const tag = `ba-429-${Math.random().toString(36).slice(2, 8)}`;
    await seedTagged(1, tag);

    const { client: throttled } = clientWithStatusResponse(
      2,
      () =>
        new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await throttled.items.bulkAction(
      { action: "transition", state: "archived", filter: { tags: [tag] } },
      { pollIntervalMs: 10, maxPollIntervalMs: 20 },
    );
    expect(result.succeeded).toBe(1);
  });

  it("ends at once on a status poll that 404s, rather than spending the budget", async () => {
    // A 404 means the job is gone. Retrying it until the wall-clock budget
    // expires would report the wrong cause thirty minutes late, so the count
    // is the assertion: one attempt, not many.
    const tag = `ba-404-${Math.random().toString(36).slice(2, 8)}`;
    await seedTagged(1, tag);

    const { client: gone, polls } = clientWithStatusResponse(
      Number.MAX_SAFE_INTEGER,
      () =>
        new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      gone.items.bulkAction(
        { action: "transition", state: "archived", filter: { tags: [tag] } },
        { pollIntervalMs: 5, maxPollIntervalMs: 5, maxWaitMs: 500 },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(polls()).toBe(1);
  });

  it("a status poll that times out delays the answer rather than inventing a failure", async () => {
    const tag = `ba-slowpoll-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seedTagged(2, tag);

    const { client: flaky } = clientWithFailingStatusPolls(2);
    const result = await flaky.items.bulkAction(
      { action: "transition", state: "archived", filter: { tags: [tag] } },
      { pollIntervalMs: 10, maxPollIntervalMs: 20 },
    );

    expect(result.succeeded).toBe(2);
    expect(result.errored).toBe(0);
    // The write is the thing being asserted on, not the promise resolving:
    // the old failure reported an error for a job that had done this.
    const fetched = await client.items.get(ids[0]!);
    expect(fetched.state).toBe("archived");
  });

  it("gives up on a status poll that keeps timing out, and says why", async () => {
    const tag = `ba-neverpoll-${Math.random().toString(36).slice(2, 8)}`;
    await seedTagged(1, tag);

    const { client: broken, polls } = clientWithFailingStatusPolls(
      Number.MAX_SAFE_INTEGER,
    );
    await expect(
      broken.items.bulkAction(
        { action: "transition", state: "archived", filter: { tags: [tag] } },
        { pollIntervalMs: 5, maxPollIntervalMs: 5, maxWaitMs: 60 },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    // The count is what makes this about the budget rather than the first
    // throw: giving up immediately rejects with the same error.
    expect(polls()).toBeGreaterThan(1);
  });

  /** A client whose status responses are slow by a known amount, so the
   *  caller's own timeout is the only thing that decides the outcome.
   *
   *  The delay honors `init.signal`, which is not a detail: the transport
   *  implements its timeout by aborting that signal, so a stub that ignores
   *  it makes every timeout in the test unreachable and the assertion
   *  meaningless. Real `fetch` honors it. */
  function clientWithSlowStatusPolls(delayMs: number): MarfaClient {
    return new MarfaClient({
      url: "http://localhost",
      apiKey: workingKey,
      fetch: async (input, init) => {
        const url = String(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.includes("/items/bulk-actions/jobs/")) {
          const signal = init?.signal ?? null;
          await new Promise<void>((resolve, reject) => {
            const done = setTimeout(resolve, delayMs);
            signal?.addEventListener("abort", () => {
              clearTimeout(done);
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
            if (signal?.aborted) {
              clearTimeout(done);
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            }
          });
        }
        return testFetchFn(input, init);
      },
    });
  }

  it("uses the status timeout the caller gave it, rather than one it pinned", async () => {
    // The transport turns `timeoutMs` into its own AbortSignal, so the value
    // never reaches the wire and cannot be asserted on a request. What can be
    // asserted is the outcome it decides: the same slow response against two
    // different timeouts has to end two different ways, or the option is
    // being ignored. It was — this call pinned five seconds and nothing
    // reached it.
    const slow = clientWithSlowStatusPolls(150);

    const tightTag = `ba-tight-${Math.random().toString(36).slice(2, 8)}`;
    await seedTagged(1, tightTag);
    await expect(
      slow.items.bulkAction(
        {
          action: "transition",
          state: "archived",
          filter: { tags: [tightTag] },
        },
        {
          statusTimeoutMs: 20,
          pollIntervalMs: 5,
          maxPollIntervalMs: 5,
          maxWaitMs: 250,
        },
      ),
    ).rejects.toMatchObject({ code: "timeout" });

    const roomyTag = `ba-roomy-${Math.random().toString(36).slice(2, 8)}`;
    const roomyIds = await seedTagged(1, roomyTag);
    const result = await slow.items.bulkAction(
      { action: "transition", state: "archived", filter: { tags: [roomyTag] } },
      { statusTimeoutMs: 5_000, pollIntervalMs: 5 },
    );
    expect(result.succeeded).toBe(1);
    expect((await client.items.get(roomyIds[0]!)).state).toBe("archived");
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

  it("update_tier, update_properties, update_occurred_at all land", async () => {
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
      action: "update_occurred_at",
      occurred_at: iso,
      filter: { tags: [tag] },
    });

    const fetched = await client.items.get(ids[0]!);
    expect(fetched.tier).toBe("feed");
    expect((fetched.properties as { extra_bulk?: string }).extra_bulk).toBe(
      "patched",
    );
    expect(fetched.occurred_at).toBe(iso);
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

  it("filter.tier stays narrower than GET /items, and filter.state does not", () => {
    // The assertion here is the compile step, not a runtime expectation.
    // Each `@ts-expect-error` fails the build the moment the error it
    // names stops happening, which is exactly what widening the field
    // would do. Types are erased before this body runs, so no runtime
    // check can distinguish a narrowed type from a wide one — the
    // sibling below holds the route's half. This goes red under
    // `typecheck` rather than under the runner.

    // @ts-expect-error — the bulk-action route has no `"all"` catch-all
    // on tier; that only exists on GET /items' wider ListFilters.
    const rejectedTier: BulkActionFilter = { tier: "all" };

    // `revoked` must ASSIGN. The route's filter takes every lifecycle
    // value, and the reserved namespace's lifecycle is exactly `active`
    // and `revoked` — so a filter refusing it puts every reserved row
    // beyond the reach of any bulk action. This line failing to compile
    // is the regression, not the fix.
    const revokedFilter: BulkActionFilter = { state: "revoked" };

    // The other half, so this pins the tier narrowing to exactly one
    // value rather than to anything wider: these must still assign.
    const acceptedState: BulkActionFilter = { state: "trashed" };
    const acceptedTier: BulkActionFilter = { tier: "library" };

    // The action's own target state is a different set from the filter's
    // and deliberately smaller: a bulk action selects revoked rows but may
    // not move a row into `revoked`.
    //
    // The directive sits on the property rather than above the
    // declaration, because that is where the compiler reports it. Above
    // the `const` it suppresses nothing and `@ts-expect-error` then fails
    // the build as unused — and with the type missing from the imports it
    // was satisfied by "cannot find name" instead, which let the whole
    // assertion pass while pinning nothing at all.
    const rejectedTarget: BulkActionInput = {
      action: "transition",
      // @ts-expect-error — `revoked` is not a transition target.
      state: "revoked",
    };

    void [
      rejectedTier,
      revokedFilter,
      acceptedState,
      acceptedTier,
      rejectedTarget,
    ];
  });

  it("the route refuses tier: all and a state that is not a state, and takes revoked", async () => {
    const tag = `ba-narrow-${Math.random().toString(36).slice(2, 8)}`;
    await seedTagged(1, tag);
    const base = {
      action: "transition" as const,
      state: "archived" as const,
      dry_run: true,
    };

    // The control, so a zero below cannot be read as the tag never
    // landing.
    await expect(
      client.items.bulkAction({ ...base, filter: { tags: [tag] } }),
    ).resolves.toMatchObject({ matched: 1 });

    // `tier` is refused: the route has no `"all"` catch-all, and says so.
    await expect(
      client.items.bulkAction({
        ...base,
        filter: { tags: [tag], tier: "all" } as unknown as BulkActionFilter,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    // A value that is not a lifecycle state is still refused, which is
    // the signal that matters: a typo does not become a quiet zero.
    await expect(
      client.items.bulkAction({
        ...base,
        filter: { tags: [tag], state: "revokd" } as unknown as BulkActionFilter,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    // `revoked` is a real lifecycle value and the filter takes it. The
    // zero here is a property of this fixture, which seeds no revoked
    // rows — not of the route. Asserting it pins the direction: a filter
    // naming a state that genuinely selects nothing is a filter working,
    // and the kit's type must keep offering it, because the reserved
    // namespace's lifecycle is exactly `active` and `revoked` and a kit
    // that refused it would put every reserved row beyond bulk reach.
    await expect(
      client.items.bulkAction({
        ...base,
        filter: { tags: [tag], state: "revoked" },
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

/**
 * The opt-in that widens the row set, on the helper that walks every page.
 *
 * The hydrating list helpers spend `include` on their own token, so the
 * `system` opt-in reaches them as a named option instead. The walk helpers
 * delegate to those, and until they carried the option a caller asking the
 * kit for everything got everything except the reserved namespace — silently,
 * and on the API a re-import reaches for first.
 *
 * Every case asserts the request that left as well as the rows that came
 * back, and pages deliberately: forwarding that works on page one and stops
 * on page two returns a set that reads exactly like a complete one. Each
 * absence is paired with a presence, because an assertion that only checks
 * the system row is missing passes against a walk that returned nothing.
 */
describe("the paging helpers and the system opt-in", () => {
  /** A client whose every outgoing URL is recorded, over the same server. */
  function recordingClient(): { client: MarfaClient; urls: URL[] } {
    const urls: URL[] = [];
    return {
      urls,
      client: new MarfaClient({
        url: "http://localhost",
        apiKey: workingKey,
        fetch: (input, init) => {
          urls.push(
            new URL(
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
            ),
          );
          return testFetchFn(input, init);
        },
      }),
    };
  }

  /**
   * **The system row is seeded through storage, because no credential writes
   * one.** `system.*` belongs to the platform's own machinery — the manifest
   * registrar, the connection bridge, the provider store — and every one of
   * those writes through the storage layer rather than through a credential.
   * The API door refuses the namespace outright, and the only credential that
   * used to reach it did so through the role bypass this model removed.
   */
  async function seedPair(
    marker: string,
  ): Promise<{ noteId: string; deviceId: string }> {
    const note = await client.items.create({
      type: "core.note",
      properties: { body: marker },
      tags: [marker],
    });
    const device = await testStorage.items.create({
      type: "system.device",
      properties: { name: marker, kind: "laptop" },
      tags: [marker],
      source: "sdk-test",
      tier: "library",
    });
    return { noteId: note.id, deviceId: device.id };
  }

  /** The `include` token set on every request the walk made. */
  function includesSent(urls: URL[]): (string | null)[] {
    return urls.map((url) => url.searchParams.get("include"));
  }

  it("omits system.* rows from a metadata walk that does not ask for them", async () => {
    const marker = "walk-metadata-absent";
    const { noteId, deviceId } = await seedPair(marker);
    const { client: recorded, urls } = recordingClient();

    const ids = await collect(
      recorded.items.listAllWithMetadata({ tags: [marker], limit: 1 }),
      { maxItems: 50 },
    ).then((rows) => rows.map((row) => row.item.id));

    expect(ids).toContain(noteId);
    expect(ids).not.toContain(deviceId);
    expect(includesSent(urls)).toEqual(
      Array.from({ length: urls.length }, () => "metadata"),
    );
  });

  it("carries the system opt-in on every page of a metadata walk", async () => {
    const marker = "walk-metadata-present";
    const { noteId, deviceId } = await seedPair(marker);
    const { client: recorded, urls } = recordingClient();

    // `limit: 1` against two matching rows, so the walk pages and the
    // assertion below covers a request the first page did not make.
    const ids = await collect(
      recorded.items.listAllWithMetadata({
        tags: [marker],
        limit: 1,
        includeSystemTypes: true,
      }),
      { maxItems: 50 },
    ).then((rows) => rows.map((row) => row.item.id));

    expect(ids).toContain(noteId);
    expect(ids).toContain(deviceId);
    expect(urls.length).toBeGreaterThan(1);
    expect(includesSent(urls)).toEqual(
      Array.from({ length: urls.length }, () => "metadata,system"),
    );
  });

  it("carries the system opt-in on every page of an extensions walk", async () => {
    const marker = "walk-extensions-present";
    const { noteId, deviceId } = await seedPair(marker);
    const { client: recorded, urls } = recordingClient();

    const ids = await collect(
      recorded.items.listAllWithExtensions({
        tags: [marker],
        limit: 1,
        includeSystemTypes: true,
      }),
      { maxItems: 50 },
    ).then((rows) => rows.map((row) => row.id));

    expect(ids).toContain(noteId);
    expect(ids).toContain(deviceId);
    expect(urls.length).toBeGreaterThan(1);
    expect(includesSent(urls)).toEqual(
      Array.from({ length: urls.length }, () => "extensions,system"),
    );
  });

  it("reaches system.* rows through search only when asked, and sends the token", async () => {
    // The declaration is the whole of this fix -- the runtime already spread
    // its filters into the query -- so the test that matters is the one that
    // fails when the declaration goes away rather than one asserting a type.
    // Both halves in one case: the token leaves, and the rows it widens to
    // arrive. Without the paired negative, a search that returned everything
    // would pass.
    const marker = "search-system-optin";
    await seedPair(marker);
    const { client: recorded, urls } = recordingClient();

    const without = await recorded
      .search(marker, { tags: [marker] })
      .then((rows) => rows.map((row) => row.item.type));
    const with_ = await recorded
      .search(marker, { tags: [marker], include: "system" })
      .then((rows) => rows.map((row) => row.item.type));

    expect(without).toContain("core.note");
    expect(without).not.toContain("system.device");
    expect(with_).toContain("core.note");
    expect(with_).toContain("system.device");
    expect(includesSent(urls)).toEqual([null, "system"]);
  });

  it("omits system.* rows from an extensions walk that does not ask for them", async () => {
    const marker = "walk-extensions-absent";
    const { noteId, deviceId } = await seedPair(marker);
    const { client: recorded, urls } = recordingClient();

    const ids = await collect(
      recorded.items.listAllWithExtensions({ tags: [marker], limit: 1 }),
      { maxItems: 50 },
    ).then((rows) => rows.map((row) => row.id));

    expect(ids).toContain(noteId);
    expect(ids).not.toContain(deviceId);
    expect(includesSent(urls)).toEqual(
      Array.from({ length: urls.length }, () => "extensions"),
    );
  });
});
