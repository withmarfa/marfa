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

/** Create two items via POST /items and return their ids. Helper for the
 *  "I need a source + a target" setup that every test needs. */
async function makePair(): Promise<{ sourceId: string; targetId: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const src = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "core.note",
      properties: { body: "source" },
      source_id: `src-${suffix}`,
    },
  });
  const tgt = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "core.entity",
      properties: { name: "target" },
      source_id: `tgt-${suffix}`,
    },
  });
  const s = (await src.json()) as { item: { id: string } };
  const t = (await tgt.json()) as { item: { id: string } };
  return { sourceId: s.item.id, targetId: t.item.id };
}

describe("POST /edges/bulk", () => {
  it("creates edges in bulk (upsert default)", async () => {
    const a = await makePair();
    const b = await makePair();

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
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

  it("upsert mode replaces properties on existing (source, target, type) triples", async () => {
    const { sourceId, targetId } = await makePair();

    const first = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: sourceId,
            target_id: targetId,
            edge_type: "about",
            properties: { weight: 1 },
          },
        ],
      },
    });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
    };
    const originalId = firstBody.results[0]!.id;

    const second = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: sourceId,
            target_id: targetId,
            edge_type: "about",
            properties: { weight: 42 },
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

    // Verify properties were replaced in place. No GET /edges/:id route,
    // so hydrate via the source item's outbound edge listing.
    const getRes = await request(
      ctx.app,
      "GET",
      `/items/${sourceId}/edges?edge_type=about`,
      { key: ctx.adminKey },
    );
    const listBody = (await getRes.json()) as {
      data: { id: string; properties: { weight?: number } }[];
    };
    const hit = listBody.data.find((e) => e.id === originalId);
    expect(hit?.properties.weight).toBe(42);
  });

  it("create_only mode surfaces duplicates as skipped", async () => {
    const { sourceId, targetId } = await makePair();

    await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: sourceId,
            target_id: targetId,
            edge_type: "about",
          },
        ],
        mode: "create_only",
      },
    });

    const second = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: sourceId,
            target_id: targetId,
            edge_type: "about",
            properties: { should_not: "apply" },
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
    expect(body.results[0]!.reason).toBe("duplicate_edge");
  });

  it("atomic=true rolls back the whole batch on any error", async () => {
    const a = await makePair();
    // Second pair contains an invalid target id to force a validation error
    // mid-batch.
    const bogusTarget = "not-a-valid-id";

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: a.sourceId,
            target_id: a.targetId,
            edge_type: "about",
          },
          {
            source_id: a.sourceId,
            target_id: bogusTarget,
            edge_type: "about",
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

    // The first (valid) edge should not have been persisted — rollback works.
    const list = await request(
      ctx.app,
      "GET",
      `/items/${a.sourceId}/edges?edge_type=about`,
      { key: ctx.adminKey },
    );
    const listBody = (await list.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });

  it("atomic=false collects errors and continues", async () => {
    const a = await makePair();
    const b = await makePair();

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
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
          {
            source_id: b.sourceId,
            target_id: b.targetId,
            edge_type: "about",
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
    expect(body.results[1]!.error?.code).toBe("invalid_id");
  });

  it("surfaces unknown edge_type as validation error", async () => {
    const { sourceId, targetId } = await makePair();
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: sourceId,
            target_id: targetId,
            edge_type: "nonexistent-type",
          },
        ],
        atomic: false,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { errored: number };
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.counts.errored).toBe(1);
    expect(body.results[0]!.error?.code).toBe("edge_type_not_found");
  });

  it("rejects self-edges with edge_constraint_violation", async () => {
    const { sourceId } = await makePair();
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: sourceId,
            target_id: sourceId,
            edge_type: "about",
          },
        ],
        atomic: false,
      },
    });
    const body = (await res.json()) as {
      counts: { errored: number };
      results: { error?: { code: string } }[];
    };
    expect(body.counts.errored).toBe(1);
    expect(body.results[0]!.error?.code).toBe("edge_constraint_violation");
  });

  it("rejects cardinality violation (parent-of: target already has parent)", async () => {
    const p1 = await makePair();
    const parent2 = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "second parent" },
      },
    });
    const parent2Id = ((await parent2.json()) as { item: { id: string } }).item
      .id;

    // First parent-of edge lands fine.
    const first = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: p1.sourceId,
            target_id: p1.targetId,
            edge_type: "parent-of",
          },
        ],
      },
    });
    expect(first.status).toBe(200);

    // Second edge targeting the same child from a different parent violates
    // the one-to-many cardinality on the target side.
    const second = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: parent2Id,
            target_id: p1.targetId,
            edge_type: "parent-of",
          },
        ],
        atomic: false,
      },
    });
    const body = (await second.json()) as {
      counts: { errored: number };
      results: { error?: { code: string } }[];
    };
    expect(body.counts.errored).toBe(1);
    expect(body.results[0]!.error?.code).toBe("edge_constraint_violation");
  });

  it("caps at 5000 edges per call", async () => {
    const { sourceId, targetId } = await makePair();
    const edges = Array.from({ length: 5001 }, () => ({
      source_id: sourceId,
      target_id: targetId,
      edge_type: "about",
    }));
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: { edges },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("requires admin role", async () => {
    const rawKey = `myme_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "edges-bulk-member",
        source: `edges-bulk-member-${rawKey.slice(-6)}`,
        role: "member",
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
      },
      keyHash,
    );
    const { sourceId, targetId } = await makePair();

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: rawKey,
      body: {
        edges: [
          { source_id: sourceId, target_id: targetId, edge_type: "about" },
        ],
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns an empty-counts shape for an empty edges array", async () => {
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: { edges: [] },
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

  it("atomic pre-check rejects invalid id shape before any write", async () => {
    const { sourceId, targetId } = await makePair();
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          { source_id: sourceId, target_id: targetId, edge_type: "about" },
          { source_id: sourceId, target_id: "bogus", edge_type: "about" },
        ],
        atomic: true,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { index?: number; code?: string } };
    };
    expect(body.error.code).toBe("bulk_atomic_rollback");
    expect(body.error.details?.index).toBe(1);
    expect(body.error.details?.code).toBe("invalid_id");
  });
});
