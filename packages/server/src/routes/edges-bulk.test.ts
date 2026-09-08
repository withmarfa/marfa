import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { generateId } from "@withmarfa/shared";

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

  it("upsert mode merges properties over existing (source, target, type) triples", async () => {
    const { sourceId, targetId } = await makePair();

    const first = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: sourceId,
            target_id: targetId,
            edge_type: "about",
            properties: { weight: 1, label: "kept" },
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

    // Verify the named property moved and the unnamed one survived. The
    // second call names `weight` alone, so a replacing door would leave
    // `label` gone — which is what this case looked like before the
    // upsert started merging, and why it carries two properties now.
    // No GET /edges/:id route on this listing path, so hydrate via the
    // source item's outbound edge listing.
    const getRes = await request(
      ctx.app,
      "GET",
      `/items/${sourceId}/edges?edge_type=about`,
      { key: ctx.adminKey },
    );
    const listBody = (await getRes.json()) as {
      data: { id: string; properties: { weight?: number; label?: string } }[];
    };
    const hit = listBody.data.find((e) => e.id === originalId);
    expect(hit?.properties.weight).toBe(42);
    expect(hit?.properties.label).toBe("kept");
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

  it("admits a key with source-type + edge-type write (matches POST /edges)", async () => {
    // Bulk edge authorization mirrors single-edge POST /edges: a key holding
    // write on the source item's type AND the edge type succeeds.
    const rawKey = `marfa_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "edges-bulk-member-ok",
        source: `edges-bulk-member-ok-${rawKey.slice(-6)}`,
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        // Keys mode gives this key no space, and a space-less key must be an
        // operator key. The subject is the edge map, which an operator key
        // does not bypass.
        is_operator: true,
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: { created: number } };
    expect(body.counts.created).toBe(1);
  });

  it("rejects a key lacking edge-type write (atomic 400)", async () => {
    // Has source-type write but no edge_permissions → edge_permission_denied,
    // surfaced as a bulk_atomic_rollback by the atomic pre-check.
    const rawKey = `marfa_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "edges-bulk-member-noedge",
        source: `edges-bulk-member-noedge-${rawKey.slice(-6)}`,
        type_permissions: { "*": "write" },
        edge_permissions: {},
        is_operator: true,
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { code?: string } };
    };
    expect(body.error.code).toBe("bulk_atomic_rollback");
    expect(body.error.details?.code).toBe("edge_permission_denied");
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

describe("POST /edges/bulk — the client-supplied id", () => {
  interface BulkBody {
    results: { index: number; outcome: string; error?: { code: string } }[];
  }

  it("is refused per entry when it is not a valid identifier", async () => {
    // This door declared `id` first and stored it verbatim, so the single
    // door's gate had to reach here too — two doors writing one column
    // answering to two rules is the shape that lets one of them drift.
    const pair = await makePair();
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        atomic: false,
        edges: [
          {
            id: "not-an-identifier",
            source_id: pair.sourceId,
            target_id: pair.targetId,
            edge_type: "about",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkBody;
    expect(body.results[0]?.outcome).toBe("errored");
    expect(body.results[0]?.error?.code).toBe("invalid_id");
  });

  it("rolls the whole batch back on an invalid id in atomic mode", async () => {
    // Atomic mode checks id shapes before any write, because SQLite
    // cannot roll back an async transaction — so the id gate belongs in
    // that pre-pass beside the source and target ones, not only inside
    // the per-edge path.
    const pair = await makePair();
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        atomic: true,
        edges: [
          {
            source_id: pair.sourceId,
            target_id: pair.targetId,
            edge_type: "about",
          },
          {
            id: "still-not-an-identifier",
            source_id: pair.sourceId,
            target_id: pair.targetId,
            edge_type: "references",
          },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "bulk_atomic_rollback",
    );
    // The first edge was valid and must not have survived the rollback.
    const listed = await request(
      ctx.app,
      "GET",
      `/items/${pair.sourceId}/edges`,
      { key: ctx.adminKey },
    );
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it("reports a reused id as a conflict rather than a driver error", async () => {
    // The trap lives in `createRaw`, so this door inherits it. Before it
    // existed the collision reached the driver and was rethrown past the
    // per-entry handler, which only catches a MarfaError — a 500 for the
    // whole batch rather than one errored entry.
    const first = await makePair();
    const second = await makePair();
    const shared = generateId();

    const seed = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        id: shared,
        source_id: first.sourceId,
        target_id: first.targetId,
        edge_type: "about",
      },
    });
    expect(seed.status).toBe(201);

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        atomic: false,
        edges: [
          {
            id: shared,
            source_id: second.sourceId,
            target_id: second.targetId,
            edge_type: "about",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkBody;
    expect(body.results[0]?.outcome).toBe("errored");
    expect(body.results[0]?.error?.code).toBe("conflict");
  });
});
