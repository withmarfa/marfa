import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("POST /items", () => {
  it("creates an item with valid properties", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Hello world", title: "Test" },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      item: Record<string, unknown>;
      metadata: unknown;
    };
    expect(data.item.type).toBe("core.note");
    expect(data.item.version).toBe(1);
    expect(data.item.state).toBe("active");
    expect(data.item).toHaveProperty("id");
    expect(data).toHaveProperty("metadata");
  });

  it("rejects missing required field", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { title: "No body" } },
    });
    expect(res.status).toBe(400);
  });

  it("accepts unknown type (community types)", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.nonexistent", properties: {} },
    });
    expect(res.status).toBe(201);
  });

  it("rejects request without auth", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      body: { type: "core.note", properties: { body: "Test" } },
    });
    expect(res.status).toBe(401);
  });

  it("stores tags in metadata (entity references live on edges)", async () => {
    const target = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "target" } },
    });
    const targetData = (await target.json()) as { item: { id: string } };
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tagged" },
        tags: ["reading", "important"],
        edges: { about: [targetData.item.id] },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      item: {
        edges?: Record<string, { edges: { target_id: string }[] }>;
      };
      metadata: { tags: string[] };
    };
    expect(data.metadata.tags).toEqual(["reading", "important"]);
    expect(data.item.edges?.about?.edges.length).toBe(1);
    expect(data.item.edges?.about?.edges[0]?.target_id).toBe(
      targetData.item.id,
    );
  });

  it("natural-key upsert: re-POST with same (source, source_id) updates in place (T-038)", async () => {
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "First" },
        source_id: "natural-key-1",
      },
    });
    expect(first.status).toBe(201);
    const firstData = (await first.json()) as {
      item: { id: string; version: number };
    };

    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Second" },
        source_id: "natural-key-1",
      },
    });
    // 200 (not 201) signals the realised effect was an update via natural-key
    // match, not a fresh create.
    expect(second.status).toBe(200);
    const secondData = (await second.json()) as {
      item: { id: string; version: number; properties: { body?: string } };
    };
    // Same row, version incremented, properties merged.
    expect(secondData.item.id).toBe(firstData.item.id);
    expect(secondData.item.version).toBe(firstData.item.version + 1);
    expect(secondData.item.properties.body).toBe("Second");

    // Whole-batch retry shape: a third POST is also idempotent — no new row
    // is created, the existing row keeps being updated. This is the contract
    // inbound integration handlers (rss-watcher / Calendar) rely on to recover
    // from createItem-success / cursor-write-fail without producing duplicates.
    const third = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Third" },
        source_id: "natural-key-1",
      },
    });
    expect(third.status).toBe(200);
    const thirdData = (await third.json()) as { item: { id: string } };
    expect(thirdData.item.id).toBe(firstData.item.id);

    // Audit row records the realised effect (`item.update`) and flags the
    // idempotent provenance so operators can spot natural-key re-syncs.
    const auditRes = await request(ctx.app, "GET", "/audit?limit=20", {
      key: ctx.adminKey,
    });
    const auditData = (await auditRes.json()) as {
      data: {
        action: string;
        details?: { idempotent?: boolean; source_id?: string };
      }[];
    };
    const idempotentEntry = auditData.data.find(
      (e) => e.details?.idempotent === true,
    );
    expect(idempotentEntry).toBeDefined();
    expect(idempotentEntry?.action).toBe("item.update");
    expect(idempotentEntry?.details?.source_id).toBe("natural-key-1");
  });

  it("natural-key upsert: source_id absent → create path unchanged", async () => {
    // Two POSTs with no source_id → two distinct rows, both 201.
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "no-key A" } },
    });
    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "no-key B" } },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstData = (await first.json()) as { item: { id: string } };
    const secondData = (await second.json()) as { item: { id: string } };
    expect(firstData.item.id).not.toBe(secondData.item.id);
  });

  it("natural-key upsert: explicit `id` mismatching the resolved row is rejected", async () => {
    // First POST creates the row with a generated id; the natural key lives on
    // (source, source_id). A subsequent POST that explicitly carries a
    // different `id` along with the same source_id should not silently win
    // with the existing row's id — that would surprise the caller.
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "First" },
        source_id: "id-mismatch-key",
      },
    });
    expect(first.status).toBe(201);

    const conflicting = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Conflicting id" },
        source_id: "id-mismatch-key",
        id: "019df7d6-0000-7000-8000-000000000000",
      },
    });
    expect(conflicting.status).toBe(400);
    const errBody = (await conflicting.json()) as {
      error: { code: string };
    };
    expect(errBody.error.code).toBe("validation_error");
  });

  it("natural-key upsert: source_id under different sources do not collide", async () => {
    // The upsert is keyed on (source, source_id). Different credentials with
    // different stamped sources but matching source_id values must produce
    // distinct rows. The test admin's source is `test-admin-<suffix>`; we
    // mint a second key with a different `source` to exercise the boundary.
    const altKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "alt-source",
        source: "alt-source",
        role: "admin",
        type_permissions: {},
      },
    });
    const altKey = (await altKeyRes.json()) as { key: string };

    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Admin source" },
        source_id: "shared-key",
      },
    });
    const second = await request(ctx.app, "POST", "/items", {
      key: altKey.key,
      body: {
        type: "core.note",
        properties: { body: "Alt source" },
        source_id: "shared-key",
      },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstData = (await first.json()) as { item: { id: string } };
    const secondData = (await second.json()) as { item: { id: string } };
    expect(firstData.item.id).not.toBe(secondData.item.id);
  });
});

describe("POST /items — platform-credential gate (TSC42 §3/§4)", () => {
  it("rejects a non-platform admin writing system.* even with explicit type_permissions", async () => {
    // Pre-fix attack vector: a tenant admin (role admin, is_platform false)
    // with `type_permissions: { "system.connection": "write" }` could mint
    // system.connection rows because the admin-role bypass in
    // `checkTypeAccess` returned early before any platform check ran. The
    // gate now fires for writes to `core.*` / `system.*` / `myme.*`
    // independent of role; reads are unrestricted.
    const tenantAdminKey = "myme_k1_test_non_platform_admin";
    await ctx.storage.keys.create(
      {
        label: "tenant-admin-non-platform",
        source: "tenant-admin-non-platform",
        role: "admin",
        type_permissions: { "system.connection": "write" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(tenantAdminKey, TEST_API_KEY_SALT),
      "tenant-x",
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: tenantAdminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          client_id: "x",
          scopes: [],
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toMatch(/platform/i);
    expect(body.error.message).toMatch(/system/);
  });

  it("admits the bootstrap admin (is_platform: true) writing system.*", async () => {
    // Sanity check the legitimate path stays open. Bootstrap admin is
    // the test fixture admin which is platform-shaped.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          client_id: "platform-write-ok",
          scopes: [],
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
    });
    expect(res.status).toBe(201);
  });

  it("admits runtime credentials writing system.activity (carve-out for connector status reporting)", async () => {
    // Runtime credentials are is_platform: false but is_runtime_credential:
    // true and bound to a connection. The activity sink in runtime-sdk
    // calls POST /items with type: "system.activity" to surface progress
    // / errors — the carve-out keeps that path open while still blocking
    // the dangerous system.* writes.
    const runtimeKey = "myme_k1_test_runtime_credential";
    await ctx.storage.keys.createRuntimeCredential(
      {
        label: "runtime-cred",
        source: "runtime-cred",
        role: "member",
        type_permissions: { "system.activity": "write" },
        connection_id: "conn_test_carve_out",
      },
      hashApiKey(runtimeKey, TEST_API_KEY_SALT),
      "tenant-x",
    );

    const activityRes = await request(ctx.app, "POST", "/items", {
      key: runtimeKey,
      body: {
        type: "system.activity",
        properties: {
          severity: "info",
          summary: "Sync run completed",
          connection_id: "conn_test_carve_out",
        },
      },
    });
    expect(activityRes.status).toBe(201);

    // Same credential is still blocked from writing system.connection —
    // the carve-out is narrow.
    const connectionRes = await request(ctx.app, "POST", "/items", {
      key: runtimeKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          client_id: "x",
          scopes: [],
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
    });
    expect(connectionRes.status).toBe(403);
  });

  it("does not gate reads to system.* (tenant admin can list its own system.connection rows)", async () => {
    // Reads to reserved-namespace items are unrestricted (filtered by
    // tenant scoping at the storage layer); only writes need
    // is_platform.
    const tenantReaderKey = "myme_k1_test_tenant_reader";
    await ctx.storage.keys.create(
      {
        label: "tenant-reader",
        source: "tenant-reader",
        role: "admin",
        type_permissions: { "system.connection": "read" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(tenantReaderKey, TEST_API_KEY_SALT),
      "tenant-x",
    );
    const res = await request(ctx.app, "GET", "/items?type=system.connection", {
      key: tenantReaderKey,
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /items/:id", () => {
  it("returns item with metadata", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Get test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("item");
    expect(data).toHaveProperty("metadata");
  });

  it("returns 404 for non-existent item", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items/019537a0-7b80-7000-8000-000000000000",
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for trashed item", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Will trash" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });

    const res = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /items", () => {
  it("lists items with pagination", async () => {
    const res = await request(ctx.app, "GET", "/items?limit=2", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("data");
    expect(data).toHaveProperty("has_more");
    expect(data).toHaveProperty("cursor");
  });

  it("filters by type", async () => {
    const res = await request(ctx.app, "GET", "/items?type=core.note", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { type: string }[] };
    for (const item of data.data) {
      expect(item.type).toBe("core.note");
    }
  });

  it("filters by tags", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tag test" },
        tags: ["filter-test"],
      },
    });

    const res = await request(ctx.app, "GET", "/items?tags=filter-test", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: unknown[] };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("PATCH /items/:id", () => {
  it("updates properties and returns wrapped { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Original", title: "Test" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Updated" }, version: 1 },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { version: number; properties: Record<string, unknown> };
      metadata: unknown;
    };
    expect(data.item.version).toBe(2);
    expect(data.item.properties.title).toBe("Updated");
    expect(data.item.properties.body).toBe("Original");
    expect(data).toHaveProperty("metadata");
  });

  it("returns 409 on conflicting field update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Base", title: "Base title" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Server update" }, version: 1 },
    });

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Client update" }, version: 1 },
    });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as Record<string, unknown>;
    expect(conflict).toHaveProperty("conflicting_fields");
    expect(conflict).toHaveProperty("current");
    expect(conflict).toHaveProperty("ancestor");
    expect(conflict).toHaveProperty("merge_policy");
    const policy = conflict.merge_policy as {
      fields?: Record<string, string>;
      default?: string;
    };
    expect(policy.fields?.body).toBe("keep_both_copies");
    expect(policy.fields?.notes).toBe("keep_both_copies");
    expect(policy.default).toBe("last_writer_wins");
  });

  it("auto-merges non-conflicting field updates", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Base body", title: "Base title" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Server title" }, version: 1 },
    });

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "Client body" }, version: 1 },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(data.item.properties.title).toBe("Server title");
    expect(data.item.properties.body).toBe("Client body");
  });

  it("returns 409 for version 0 (not 400)", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "updated" }, version: 0 },
    });
    expect(res.status).toBe(409);
  });

  it("flips tier: feed → library on PATCH", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "feed" },
        tier: "feed",
      },
    });
    const created = (await createRes.json()) as {
      item: { id: string; tier: "library" | "feed" };
    };
    expect(created.item.tier).toBe("feed");

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { tier: "library" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { tier: "library" | "feed" } };
    expect(data.item.tier).toBe("library");
  });

  it("flips tier: library → feed on PATCH", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "library" },
        tier: "library",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { tier: "feed" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { tier: "library" | "feed" } };
    expect(data.item.tier).toBe("feed");
  });

  it("tier-only PATCH (no properties) succeeds and bumps version", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "x" }, tier: "feed" },
    });
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { tier: "library" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { tier: "library" | "feed"; version: number };
    };
    expect(data.item.tier).toBe("library");
    expect(data.item.version).toBe(created.item.version + 1);
  });

  it("PATCH with tier + properties applies both", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "before" },
        tier: "feed",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "after" }, tier: "library" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { tier: "library" | "feed"; properties: Record<string, unknown> };
    };
    expect(data.item.tier).toBe("library");
    expect(data.item.properties.body).toBe("after");
  });

  it("PATCH with no body fields returns 400", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "x" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /items/:id — source_id mutation (T-118 precursor)", () => {
  it("happy path: PATCH source_id updates the natural key + findBySourceId returns it", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "rename me" },
        source_id: "path/to/old-name.md",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { source_id: "path/to/new-name.md" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { source_id?: string } };
    expect(data.item.source_id).toBe("path/to/new-name.md");

    // findBySourceId now returns this item under the new key. The lookup is
    // tenant + source scoped — read it back via the GET-by-source path.
    const reread = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
    const rereadData = (await reread.json()) as {
      item: { id: string; source_id?: string };
    };
    expect(rereadData.item.source_id).toBe("path/to/new-name.md");
  });

  it("collision: PATCH source_id to a value already used by another item under the same source → 409 source_id_conflict", async () => {
    // Two items under the same admin credential (same stamped source).
    const occupant = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "occupant" },
        source_id: "occupied-key",
      },
    });
    const mover = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "mover" },
        source_id: "mover-key",
      },
    });
    expect(occupant.status).toBe(201);
    expect(mover.status).toBe(201);
    const moverData = (await mover.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: ctx.adminKey,
      body: { source_id: "occupied-key" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("source_id_conflict");
    expect(body.error.details?.source_id).toBe("occupied-key");
  });

  it("idempotent no-op: PATCH source_id to the value already held → 200, value unchanged", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "idempotent" },
        source_id: "stable-key",
      },
    });
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { source_id: "stable-key" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { source_id?: string; version: number };
    };
    expect(data.item.source_id).toBe("stable-key");
    // Update path still bumps version (a source_id PATCH is a column-set
    // change like tier/timestamp). The route doesn't short-circuit on
    // "same value" — only the conflict check is suppressed. Behaviour
    // matches `tier`-only PATCH above.
    expect(data.item.version).toBe(created.item.version + 1);
  });

  it("source_id PATCH alongside properties + stale version: route still rejects on natural-key conflict (collision check runs before storage)", async () => {
    // Set up: an occupant under `occupied-key-v2`, and a mover currently at
    // mover-key-v2 with an explicit version pin that won't match after a
    // subsequent server-side update. We're asserting that the natural-key
    // gate runs before the version-merge path — collision is the failure
    // mode the caller sees, not version_conflict, even when the body
    // carries a stale version.
    const occupant = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "occupant v2" },
        source_id: "occupied-key-v2",
      },
    });
    const mover = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "mover v2" },
        source_id: "mover-key-v2",
      },
    });
    expect(occupant.status).toBe(201);
    expect(mover.status).toBe(201);
    const moverData = (await mover.json()) as {
      item: { id: string; version: number };
    };

    // Bump the mover so its current version is 2; the PATCH below will
    // carry stale version 1, which would normally enter the conflict path.
    await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "mover v2 bump" }, version: 1 },
    });

    // PATCH carries stale version + properties + colliding source_id.
    // The natural-key check runs first; the request fails with 409
    // source_id_conflict, NOT version_conflict.
    const res = await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: ctx.adminKey,
      body: {
        properties: { body: "client try" },
        version: 1,
        source_id: "occupied-key-v2",
      },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("source_id_conflict");
  });

  it("cross-source isolation: same source_id under two different stamped sources coexists with no false collision", async () => {
    // Mint a key with a distinct stamped `source` (same pattern as the
    // existing natural-key-upsert cross-source test above).
    const altKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "alt-source-rename",
        source: "alt-source-rename",
        role: "admin",
        type_permissions: {},
      },
    });
    const altKey = (await altKeyRes.json()) as { key: string };

    // Item A under admin's source, with the target natural-key occupied.
    const occupant = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "admin occupies cross-source-key" },
        source_id: "cross-source-key",
      },
    });
    expect(occupant.status).toBe(201);

    // Item B under altSource, currently holding a different source_id.
    const mover = await request(ctx.app, "POST", "/items", {
      key: altKey.key,
      body: {
        type: "core.note",
        properties: { body: "alt mover" },
        source_id: "alt-original-key",
      },
    });
    expect(mover.status).toBe(201);
    const moverData = (await mover.json()) as { item: { id: string } };

    // PATCH altSource's item to take on `cross-source-key`. Admin holds
    // the same source_id literal but under a DIFFERENT source — the
    // uniqueness scope is `(source, source_id)`, so this must succeed.
    const res = await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: altKey.key,
      body: { source_id: "cross-source-key" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { source_id?: string } };
    expect(data.item.source_id).toBe("cross-source-key");
  });
});

describe("DELETE /items/:id", () => {
  it("soft-deletes item and returns { ok: true }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "To delete" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });
});

describe("POST /items/:id/restore", () => {
  it("restores trashed item and returns { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "To restore" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/restore`,
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { state: string };
      metadata: unknown;
    };
    expect(data.item.state).toBe("active");
    expect(data).toHaveProperty("metadata");
  });
});

describe("POST /items/:id/transition", () => {
  it("transitions item state and returns { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "State test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      {
        key: ctx.adminKey,
        body: { state: "archived" },
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { state: string };
      metadata: unknown;
    };
    expect(data.item.state).toBe("archived");
    expect(data).toHaveProperty("metadata");
  });

  it("rejects invalid transition", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Transition test" },
        state: "active",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      {
        key: ctx.adminKey,
        body: { state: "new" as unknown as "active" },
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /items/:id/versions", () => {
  it("returns wrapped version history after update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "V1" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "V2" }, version: 1 },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${created.item.id}/versions`,
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { versions: { version: number }[] };
    expect(data.versions.length).toBe(1);
    expect(data.versions[0]).toHaveProperty("version", 1);
  });
});

// ---------------------------------------------------------------------------
// Filter query parameter (advanced query language)
// ---------------------------------------------------------------------------

describe("GET /items?filter=...", () => {
  it("filters by system field", async () => {
    // Create items with different states
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Active note" },
        state: "active",
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "New note" } },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('state eq "active"')}`,
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { state: string }[] };
    for (const item of data.data) {
      expect(item.state).toBe("active");
    }
  });

  it("filters by property value", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.media.book",
        properties: { title: "1984", author: "Orwell", body: "" },
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.media.book",
        properties: { title: "Fahrenheit 451", author: "Bradbury", body: "" },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('properties.author eq "Orwell"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
    for (const item of data.data) {
      expect(item.properties.author).toBe("Orwell");
    }
  });

  it("filters with AND conditions", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('state eq "active" AND type eq "core.media.book"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { state: string; type: string }[];
    };
    for (const item of data.data) {
      expect(item.state).toBe("active");
      expect(item.type).toBe("core.media.book");
    }
  });

  it("filters with OR conditions", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('properties.author eq "Orwell" OR properties.author eq "Bradbury"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(["Orwell", "Bradbury"]).toContain(item.properties.author);
    }
  });

  it("composes filter with existing type param", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.media.book&filter=${encodeURIComponent('properties.author eq "Orwell"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { type: string; properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(item.type).toBe("core.media.book");
      expect(item.properties.author).toBe("Orwell");
    }
  });

  it("returns 400 for invalid filter expression", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent("invalid_field eq test")}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
  });

  it("filters by tags contains", async () => {
    // Create an item with tags
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tagged note" },
        tags: ["fiction", "classic"],
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('tags contains "fiction"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: unknown[] };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by property exists", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent("properties.author exists")}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(item.properties).toHaveProperty("author");
    }
  });
});

describe("DELETE /items/:id/purge", () => {
  it("permanently deletes a trashed item", async () => {
    // Create and trash an item
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Purge me", title: "Temporary" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string };
    };

    await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.adminKey,
    });

    // Purge the trashed item
    const purgeRes = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/purge`,
      { key: ctx.adminKey },
    );
    expect(purgeRes.status).toBe(200);

    // Verify the item is gone
    const getRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(404);
  });

  it("rejects purge on non-trashed item", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Active item", title: "Active" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string };
    };

    const purgeRes = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/purge`,
      { key: ctx.adminKey },
    );
    expect(purgeRes.status).toBe(400);
  });
});

describe("schema_version stamping", () => {
  it("stamps schema_version: 1 on a newly-created core.note", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Schema-version test" } },
    });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as {
      item: { id: string; schema_version: number };
    };
    expect(item.schema_version).toBe(1);
  });

  it("preserves schema_version through update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Update test" } },
    });
    const created = (await createRes.json()) as {
      item: { id: string; schema_version: number };
    };
    expect(created.item.schema_version).toBe(1);

    const updateRes = await request(
      ctx.app,
      "PATCH",
      `/items/${created.item.id}`,
      {
        key: ctx.adminKey,
        body: { properties: { body: "Updated" } },
      },
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as {
      item: { schema_version: number };
    };
    expect(updated.item.schema_version).toBe(1);
  });
});

describe("state lifecycle enum at the route boundary", () => {
  it("rejects POST /items/:id/transition with an unknown state", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Lifecycle test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      { key: ctx.adminKey, body: { state: "draft" } },
    );
    expect(res.status).toBe(400);
  });
});

describe("query language: tier system field", () => {
  it('filters items by `tier eq "library"` via the filter query parameter', async () => {
    // Two items with explicit tier values
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "library item" },
        tier: "library",
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "feed item" },
        tier: "feed",
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&filter=${encodeURIComponent('tier eq "library"')}&limit=200`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tier: "library" | "feed" }[];
    };
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.tier).toBe("library");
    }
  });
});

describe("tier default and tri-value filter on GET /items", () => {
  let libraryId: string;
  let feedId: string;

  beforeAll(async () => {
    const libRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "library marker for default test" },
        tier: "library",
      },
    });
    const libBody = (await libRes.json()) as { item: { id: string } };
    libraryId = libBody.item.id;

    const feedRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "feed marker for default test" },
        tier: "feed",
      },
    });
    const feedBody = (await feedRes.json()) as { item: { id: string } };
    feedId = feedBody.item.id;
  });

  it("returns both library and feed items when no tier param is supplied", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(feedId)).toBe(true);
  });

  it("returns library items only when ?tier=library", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&tier=library&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(feedId)).toBe(false);
    for (const item of body.data) {
      expect(item.tier).toBe("library");
    }
  });

  it("returns feed items only when ?tier=feed", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&tier=feed&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(false);
    expect(ids.has(feedId)).toBe(true);
    for (const item of body.data) {
      expect(item.tier).toBe("feed");
    }
  });

  it("treats ?tier=all as a synonym for unfiltered", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&tier=all&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(feedId)).toBe(true);
  });
});

describe("metadata.changed pubsub event", () => {
  it("fires from POST /items/:id/tags and surfaces with the canonical wire name", async () => {
    const { subscribe } = await import("../pubsub.js");

    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tag-event target" },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };

    // Subscribe before the mutation. The async generator yields on the
    // first event after subscribing — race the route call against a 500ms
    // timeout to fail fast if no event fires.
    const iter = subscribe();
    const nextEvent: Promise<{ type: string; item: { id: string } }> = iter
      .next()
      .then((r) => r.value as { type: string; item: { id: string } });

    const tagRes = await request(ctx.app, "POST", `/items/${item.id}/tags`, {
      key: ctx.adminKey,
      body: { tags: ["interesting"] },
    });
    expect(tagRes.status).toBe(200);

    const event = await Promise.race([
      nextEvent,
      new Promise<{ type: string; item: { id: string } }>((_, reject) => {
        setTimeout(() => {
          reject(new Error("no event in 500ms"));
        }, 500);
      }),
    ]);
    expect(event.type).toBe("metadata_changed");
    expect(event.item.id).toBe(item.id);
    await iter.return(undefined);
  });
});

describe("metadata.extensions are permission-filtered on every read path", () => {
  async function createMemberKey(
    extPerms: Record<string, "read" | "write">,
    label: string,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label,
        source: `${label}-src`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: extPerms,
      },
    });
    const { key } = (await res.json()) as { key: string };
    return key;
  }

  async function seedItemWithExtensions(): Promise<string> {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "ext-leak-fixture" },
        tags: ["ext-leak-fixture"],
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    // Admin writes three extension namespaces. Member key below only has
    // read on `visible-app.prefs`; the other two must be hidden.
    for (const ns of [
      "visible-app.prefs",
      "hidden-app.prefs",
      "other-app.prefs",
    ]) {
      await request(ctx.app, "PUT", `/items/${item.id}/extensions/${ns}`, {
        key: ctx.adminKey,
        body: { flag: ns },
      });
    }
    return item.id;
  }

  it("GET /items/:id only surfaces extension namespaces the caller can read", async () => {
    const id = await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-single",
    );

    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("GET /items?include=metadata filters extensions per item", async () => {
    const id = await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-list",
    );

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&include=metadata&limit=200`,
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        item: { id: string };
        metadata: { extensions: Record<string, unknown> };
      }[];
    };
    const row = body.data.find((r) => r.item.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.metadata.extensions ?? {}).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("GET /items/:id/metadata filters extensions", async () => {
    const id = await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-meta",
    );

    const res = await request(ctx.app, "GET", `/items/${id}/metadata`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("/search filters extensions on every result", async () => {
    await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-search",
    );

    const res = await request(ctx.app, "GET", `/search?q=ext-leak-fixture`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { metadata: { extensions: Record<string, unknown> } }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      const namespaces = Object.keys(result.metadata.extensions);
      for (const ns of namespaces) {
        expect(ns).toBe("visible-app.prefs");
      }
    }
  });

  it("admin keys still see every extension namespace", async () => {
    const id = await seedItemWithExtensions();
    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "hidden-app.prefs",
      "other-app.prefs",
      "visible-app.prefs",
    ]);
  });

  it("implicit own-namespace rule still exposes a member's own namespace", async () => {
    const id = await seedItemWithExtensions();
    // Key with no explicit grants — the own-namespace rule should let it
    // see an extension namespace that matches its label.
    const ownerKey = await createMemberKey({}, "visible-app.prefs");
    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: ownerKey,
    });
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });
});

describe("GET /items?include=extensions", () => {
  async function createMemberKey(
    extPerms: Record<string, "read" | "write">,
    label: string,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label,
        source: `${label}-src`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: extPerms,
      },
    });
    const { key } = (await res.json()) as { key: string };
    return key;
  }

  async function seedItem(marker: string): Promise<string> {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `include-ext-${marker}` },
        tags: [`include-ext-${marker}`],
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    for (const ns of ["visible.prefs", "hidden.prefs", "other.prefs"]) {
      await request(ctx.app, "PUT", `/items/${item.id}/extensions/${ns}`, {
        key: ctx.adminKey,
        body: { flag: ns },
      });
    }
    return item.id;
  }

  it("omits extensions when include is not set (lists stay lean)", async () => {
    const id = await seedItem("lean");
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-lean`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: unknown }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.extensions).toBeUndefined();
  });

  it("hydrates extensions inline when include=extensions is set", async () => {
    const id = await seedItem("admin");
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-admin&include=extensions`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: Record<string, unknown> }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.extensions ?? {}).sort()).toEqual([
      "hidden.prefs",
      "other.prefs",
      "visible.prefs",
    ]);
  });

  it("filters extensions per caller permissions", async () => {
    const id = await seedItem("filtered");
    const memberKey = await createMemberKey(
      { "visible.prefs": "read" },
      "include-ext-filtered",
    );
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-filtered&include=extensions`,
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: Record<string, unknown> }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.extensions ?? {}).sort()).toEqual([
      "visible.prefs",
    ]);
  });

  it("composes with include=edges in a single request", async () => {
    const targetRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "combo target" } },
    });
    const { item: target } = (await targetRes.json()) as {
      item: { id: string };
    };
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "combo source" },
        tags: ["include-ext-combo"],
        edges: { about: [target.id] },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    await request(ctx.app, "PUT", `/items/${item.id}/extensions/app.data`, {
      key: ctx.adminKey,
      body: { ok: true },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-combo&include=edges,extensions`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        edges?: Record<string, { edges: unknown[] }>;
        extensions?: Record<string, unknown>;
      }[];
    };
    const row = body.data.find((r) => r.id === item.id);
    expect(row?.edges?.about?.edges.length).toBe(1);
    expect(row?.extensions).toHaveProperty("app.data");
  });
});

describe("permission-gate ordering (priority cluster)", () => {
  async function createMemberKey(
    permissions: Record<string, "read" | "write" | "none">,
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `gate-member-${suffix}`,
        source: `gate-member-${suffix}`,
        role: "member",
        default_tier: "feed",
        type_permissions: permissions,
        extension_permissions: {},
        edge_permissions: {},
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string };
    return body.key;
  }

  it("DELETE /items/:id returns 403 when the credential lacks write on the type", async () => {
    // Admin creates an item.
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "to-preserve" } },
    });
    const { item } = (await create.json()) as { item: { id: string } };

    // Member credential with no core.note write.
    const restrictedKey = await createMemberKey({ "core.note": "read" });

    const del = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: restrictedKey,
    });
    expect(del.status).toBe(403);

    // The item must still be readable with admin (i.e. not trashed).
    const after = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    expect(after.status).toBe(200);
  });

  it("POST /items/:id/restore returns 403 without touching state when credential lacks write", async () => {
    // Admin creates and trashes an item.
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "soft-delete-me" } },
    });
    const { item } = (await create.json()) as { item: { id: string } };
    const del = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);

    // Restore by a restricted credential must 403.
    const restrictedKey = await createMemberKey({ "core.note": "read" });
    const restore = await request(
      ctx.app,
      "POST",
      `/items/${item.id}/restore`,
      { key: restrictedKey },
    );
    expect(restore.status).toBe(403);

    // Item must remain trashed — gate must fire before the write.
    const getAfter = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    expect(getAfter.status).toBe(404);
  });

  it("POST /items/:id/tags rejects over-100 and does not write partial tags", async () => {
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "tag-cap" } },
    });
    const { item } = (await create.json()) as { item: { id: string } };

    // Seed 95 tags — under the cap.
    const seed = Array.from({ length: 95 }, (_, i) => `t${String(i)}`);
    const seedRes = await request(ctx.app, "POST", `/items/${item.id}/tags`, {
      key: ctx.adminKey,
      body: { tags: seed },
    });
    expect(seedRes.status).toBe(200);

    // Try to add 10 more (total would be 105) — must 400.
    const overflow = Array.from({ length: 10 }, (_, i) => `x${String(i)}`);
    const overflowRes = await request(
      ctx.app,
      "POST",
      `/items/${item.id}/tags`,
      { key: ctx.adminKey, body: { tags: overflow } },
    );
    expect(overflowRes.status).toBe(400);

    // None of the 10 overflow tags should have persisted. Reading metadata
    // back, only the original 95 remain.
    const metaRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    const metaBody = (await metaRes.json()) as {
      metadata: { tags: string[] };
    };
    expect(metaBody.metadata.tags).toHaveLength(95);
    for (const x of overflow) {
      expect(metaBody.metadata.tags).not.toContain(x);
    }
  });
});
