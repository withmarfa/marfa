/**
 * Bulk edge operations — space scoping.
 *
 * `POST /edges/bulk` is reachable by a space-bound credential (widened from
 * the operator key). One can bulk-upsert edges within its own space but the
 * storage path is fenced so it never resolves, mutates, or wires another
 * space's edges:
 *
 *   - the upsert duplicate lookup (`findByTriplesBatch`) is space-scoped,
 *     so a triple that matches another space's edge is invisible — A's
 *     "upsert" of B's triple creates a fresh edge in A rather than mutating
 *     B's edge;
 *   - `updateProperties` is space-fenced as defense-in-depth;
 *   - the create path (`assertEdgeCanBeCreated`) already fences source /
 *     target items to the space, so A cannot wire B's items together.
 *
 * The operator key keeps cross-space authority.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;

const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
const spaceB = `space-b-${Math.random().toString(36).slice(2, 10)}`;
let adminA: string;
let adminB: string;

async function mintSpaceAdmin(label: string, spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_ebulk_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      space_permissions: [...SPACE_PERMISSIONS],
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

/** Create a source/target pair owned by the given space-bound key. */
async function makePair(
  key: string,
): Promise<{ sourceId: string; targetId: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const src = await request(ctx.app, "POST", "/items", {
    key,
    body: {
      type: "core.note",
      properties: { body: "source" },
      source_id: `src-${suffix}`,
    },
  });
  const tgt = await request(ctx.app, "POST", "/items", {
    key,
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

interface BulkEdgeResponse {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: { outcome: string; id: string; error?: { code: string } }[];
}

/** Hydrate an item's outbound edges via the listing route. */
async function listEdges(
  key: string,
  sourceId: string,
): Promise<{ id: string; properties: { weight?: number } }[]> {
  const res = await request(
    ctx.app,
    "GET",
    `/items/${sourceId}/edges?edge_type=about`,
    { key },
  );
  const body = (await res.json()) as {
    data: { id: string; properties: { weight?: number } }[];
  };
  return body.data;
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminA = await mintSpaceAdmin("ebulk-admin-a", spaceA);
  adminB = await mintSpaceAdmin("ebulk-admin-b", spaceB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /edges/bulk — a space-bound credential within its own space", () => {
  it("bulk-creates and upserts edges in its own space", async () => {
    const { sourceId, targetId } = await makePair(adminA);

    const create = await request(ctx.app, "POST", "/edges/bulk", {
      key: adminA,
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
    expect(create.status).toBe(200);
    const createBody = (await create.json()) as BulkEdgeResponse;
    expect(createBody.counts.created).toBe(1);
    const edgeId = createBody.results[0]!.id;

    // Upsert the same triple — updates in place within A.
    const upsert = await request(ctx.app, "POST", "/edges/bulk", {
      key: adminA,
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
    const upsertBody = (await upsert.json()) as BulkEdgeResponse;
    expect(upsertBody.counts.updated).toBe(1);
    expect(upsertBody.results[0]!.id).toBe(edgeId);

    const edges = await listEdges(adminA, sourceId);
    expect(edges.find((e) => e.id === edgeId)?.properties.weight).toBe(42);
  });
});

describe("POST /edges/bulk — cross-space isolation", () => {
  it("A cannot wire B's items together (source/target fenced to space)", async () => {
    // B owns a pair. A bulk-creates an edge referencing B's ids. The create
    // path resolves source/target within A's space, so both are 'not
    // found' and the edge errors out — no cross-space graph edge lands.
    const bPair = await makePair(adminB);

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: adminA,
      body: {
        edges: [
          {
            source_id: bPair.sourceId,
            target_id: bPair.targetId,
            edge_type: "about",
          },
        ],
        atomic: false,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkEdgeResponse;
    expect(body.counts.created).toBe(0);
    expect(body.counts.errored).toBe(1);
    expect(body.results[0]!.error?.code).toBe("item_not_found");

    // B's source still has no 'about' edge.
    const bEdges = await listEdges(adminB, bPair.sourceId);
    expect(bEdges).toHaveLength(0);
  });

  it("A's upsert of B's existing triple does not mutate B's edge", async () => {
    // B creates an edge with weight 7. A and B happen to own items, but the
    // duplicate lookup is space-scoped: A's upsert of the same (source,
    // target, type) triple as B cannot see B's edge. Since A's own items by
    // those ids don't exist in A, A's create errors — B's edge is untouched
    // and its weight unchanged.
    const bPair = await makePair(adminB);
    const seed = await request(ctx.app, "POST", "/edges/bulk", {
      key: adminB,
      body: {
        edges: [
          {
            source_id: bPair.sourceId,
            target_id: bPair.targetId,
            edge_type: "about",
            properties: { weight: 7 },
          },
        ],
      },
    });
    const seedBody = (await seed.json()) as BulkEdgeResponse;
    const bEdgeId = seedBody.results[0]!.id;

    // A attempts to upsert the identical triple with a different weight.
    const attempt = await request(ctx.app, "POST", "/edges/bulk", {
      key: adminA,
      body: {
        edges: [
          {
            source_id: bPair.sourceId,
            target_id: bPair.targetId,
            edge_type: "about",
            properties: { weight: 999 },
          },
        ],
        atomic: false,
      },
    });
    const attemptBody = (await attempt.json()) as BulkEdgeResponse;
    // The triple lookup is space-fenced, so A sees no existing edge and
    // takes the create path — which errors because the items aren't in A.
    expect(attemptBody.counts.updated).toBe(0);
    expect(attemptBody.counts.errored).toBe(1);

    // B's edge is intact with its original weight.
    const bEdges = await listEdges(adminB, bPair.sourceId);
    expect(bEdges.find((e) => e.id === bEdgeId)?.properties.weight).toBe(7);
  });
});

describe("POST /edges/bulk — the operator key unaffected", () => {
  it("the operator key bulk-creates edges (cross-space authority)", async () => {
    // The operator key's items carry no space scope; wire a fresh pair.
    const suffix = Math.random().toString(36).slice(2, 8);
    const src = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "p-src" },
        source_id: `psrc-${suffix}`,
      },
    });
    const tgt = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.entity",
        properties: { name: "p-tgt" },
        source_id: `ptgt-${suffix}`,
      },
    });
    const sourceId = ((await src.json()) as { item: { id: string } }).item.id;
    const targetId = ((await tgt.json()) as { item: { id: string } }).item.id;

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.spaceKey,
      body: {
        edges: [
          { source_id: sourceId, target_id: targetId, edge_type: "about" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkEdgeResponse;
    expect(body.counts.created).toBe(1);
  });
});
