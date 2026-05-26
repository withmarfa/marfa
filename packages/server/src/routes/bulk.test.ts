import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /items/bulk", () => {
  it("creates items in bulk (upsert default)", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "Bulk test 1" },
            source_id: `bulk-${suffix}-1`,
          },
          {
            type: "core.note",
            properties: { body: "Bulk test 2" },
            source_id: `bulk-${suffix}-2`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      counts: {
        created: number;
        updated: number;
        skipped: number;
        errored: number;
      };
      results: { outcome: string; id?: string }[];
    };
    expect(data.counts.created).toBe(2);
    expect(data.counts.updated).toBe(0);
    expect(data.counts.skipped).toBe(0);
    expect(data.counts.errored).toBe(0);
    expect(data.results).toHaveLength(2);
    for (const r of data.results) {
      expect(r.outcome).toBe("created");
      expect(r.id).toBeDefined();
    }
  });

  it("upsert mode updates existing rows matched by (source, source_id)", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sourceId = `upsert-${suffix}`;

    const first = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "initial" },
            source_id: sourceId,
          },
        ],
      },
    });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
    };
    const originalId = firstBody.results[0]!.id;

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "updated" },
            source_id: sourceId,
          },
        ],
      },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      counts: { created: number; updated: number };
      results: { outcome: string; id: string }[];
    };
    expect(body.counts.updated).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.results[0]!.id).toBe(originalId);

    const getRes = await request(ctx.app, "GET", `/items/${originalId}`, {
      key: ctx.adminKey,
    });
    const itemBody = (await getRes.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemBody.item.properties.body).toBe("updated");
  });

  it("upsert mode updates existing rows matched by id (no source_id)", async () => {
    // Offline-first clients (Swift / TS SDKs) assign UUIDs locally and
    // expect `mode: upsert` to update by primary id when a row already
    // exists server-side — e.g. migrating a local-mode Notes store whose
    // items were seeded earlier. Before this path existed, the second
    // call fell through to `items.create` and tripped a unique-
    // constraint violation (opaque 500).
    const suffix = Math.random().toString(36).slice(2, 8);

    const first = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "initial by id" },
            // No source_id — exercises the id-only match path.
          },
        ],
      },
    });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
    };
    const assignedId = firstBody.results[0]!.id;

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            id: assignedId,
            type: "core.note",
            properties: { body: `updated by id ${suffix}` },
          },
        ],
      },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      counts: { created: number; updated: number };
      results: { outcome: string; id: string }[];
    };
    expect(body.counts.updated).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.results[0]!.id).toBe(assignedId);

    const getRes = await request(ctx.app, "GET", `/items/${assignedId}`, {
      key: ctx.adminKey,
    });
    const itemBody = (await getRes.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemBody.item.properties.body).toBe(`updated by id ${suffix}`);
  });

  it("create_only mode skips existing rows matched by id with duplicate_id reason", async () => {
    const first = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "seed" },
          },
        ],
      },
    });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
    };
    const assignedId = firstBody.results[0]!.id;

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            id: assignedId,
            type: "core.note",
            properties: { body: "should be skipped" },
          },
        ],
        mode: "create_only",
      },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      counts: { skipped: number; created: number; updated: number };
      results: { outcome: string; id: string; reason?: string }[];
    };
    expect(body.counts.skipped).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.counts.updated).toBe(0);
    expect(body.results[0]!.outcome).toBe("skipped");
    expect(body.results[0]!.id).toBe(assignedId);
    expect(body.results[0]!.reason).toBe("duplicate_id");

    const getRes = await request(ctx.app, "GET", `/items/${assignedId}`, {
      key: ctx.adminKey,
    });
    const itemBody = (await getRes.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemBody.item.properties.body).toBe("seed");
  });

  it("create_only mode skips matching rows without updating", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sourceId = `createonly-${suffix}`;

    await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "original" },
            source_id: sourceId,
          },
        ],
        mode: "create_only",
      },
    });

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "should not overwrite" },
            source_id: sourceId,
          },
        ],
        mode: "create_only",
      },
    });
    const body = (await second.json()) as {
      counts: { created: number; skipped: number };
      results: { outcome: string; reason?: string }[];
    };
    expect(body.counts.skipped).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.results[0]!.outcome).toBe("skipped");
    expect(body.results[0]!.reason).toBe("duplicate_source");
  });

  it("atomic=true rolls back the whole batch on any error", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const tag = `atomic-${suffix}`;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "good" },
            tags: [tag],
            source_id: `atomic-${suffix}-good`,
          },
          {
            // Invalid type identifier — triggers the error path
            type: "NOT a valid type id",
            properties: {},
            tags: [tag],
            source_id: `atomic-${suffix}-bad`,
          },
        ],
        atomic: true,
      },
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as {
      error: { code: string; details?: { index?: number } };
    };
    expect(errBody.error.code).toBe("bulk_atomic_rollback");
    expect(errBody.error.details?.index).toBe(1);

    // Neither item should exist — rollback worked. Query by the
    // shared tag instead of source_id (filter-SQL doesn't project
    // source_id as a queryable field).
    const list = await request(ctx.app, "GET", `/items?tags=${tag}`, {
      key: ctx.adminKey,
    });
    const listBody = (await list.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });

  it("atomic=false collects errors and continues", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "first" },
            source_id: `ne-${suffix}-1`,
          },
          {
            type: "NOT a valid type",
            properties: {},
            source_id: `ne-${suffix}-bad`,
          },
          {
            type: "core.note",
            properties: { body: "third" },
            source_id: `ne-${suffix}-3`,
          },
        ],
        atomic: false,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { created: number; errored: number };
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.counts.created).toBe(2);
    expect(body.counts.errored).toBe(1);
    expect(body.results[1]!.outcome).toBe("errored");
    expect(body.results[1]!.error?.code).toBe("invalid_type");
  });

  it("accepts inline edges on create", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);

    // Create a target item first
    const targetRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.entity",
        properties: { name: "Edge target" },
        source_id: `edge-target-${suffix}`,
      },
    });
    const targetBody = (await targetRes.json()) as { item: { id: string } };
    const targetId = targetBody.item.id;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "Has inline edge" },
            source_id: `edge-source-${suffix}`,
            edges: { about: [targetId] },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string }[] };
    const sourceId = body.results[0]!.id;

    const getRes = await request(
      ctx.app,
      "GET",
      `/items/${sourceId}/edges?edge_type=about`,
      { key: ctx.adminKey },
    );
    const edgesBody = (await getRes.json()) as {
      data: { target_id: string }[];
    };
    expect(edgesBody.data).toHaveLength(1);
    expect(edgesBody.data[0]!.target_id).toBe(targetId);
  });

  it("caps at MAX_BULK_ITEMS (5000)", async () => {
    const items = Array.from({ length: 5001 }, (_, i) => ({
      type: "core.note",
      properties: { body: `over-cap-${String(i)}` },
    }));
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: { items },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("requires admin role", async () => {
    const rawKey = `marfa_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "bulk-member",
        source: `bulk-member-${rawKey.slice(-6)}`,
        role: "member",
        type_permissions: { "*": "write" },
      },
      keyHash,
    );

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: rawKey,
      body: {
        items: [{ type: "core.note", properties: { body: "nope" } }],
      },
    });
    expect(res.status).toBe(403);
  });

  it("stamps source from the credential and ignores forged payload source", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const forgedSource = "forged.origin";
    const payloadSourceId = `stamp-${suffix}`;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: `stamp test ${suffix}` },
            source: forgedSource,
            source_id: payloadSourceId,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { id: string }[];
    };
    const createdId = body.results[0]!.id;

    const getRes = await request(ctx.app, "GET", `/items/${createdId}`, {
      key: ctx.adminKey,
    });
    const item = (await getRes.json()) as {
      item: { source?: string; source_id?: string };
    };
    expect(item.item.source).not.toBe(forgedSource);
    expect(item.item.source?.startsWith("test-admin-")).toBe(true);
    expect(item.item.source_id).toBe(payloadSourceId);
  });

  it("returns an empty-counts shape for an empty items array", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: { items: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: {
        created: number;
        updated: number;
        skipped: number;
        errored: number;
      };
      results: unknown[];
    };
    expect(body.counts).toEqual({
      created: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
    });
    expect(body.results).toEqual([]);
  });
});
