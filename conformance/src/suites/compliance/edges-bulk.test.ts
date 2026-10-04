/**
 * Conformance for POST /edges/bulk.
 *
 * Scope is deliberately narrow: the wire shape of the endpoint — per-edge
 * outcomes, the upsert and create_only modes, atomic rollback, and the
 * per-edge permission gate.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { v7 as uuidv7 } from "uuid";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edges-bulk",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Create a fresh source/target item pair. Returns their server ids
 *  and tracks both for suite cleanup. */
async function makePair(): Promise<{ sourceId: string; targetId: string }> {
  const s = await client.createItem(createNote({ source: ctx.source }));
  expect(s.ok).toBe(true);
  trackItem(ctx, s.data.item.id);

  const t = await client.createItem(createNote({ source: ctx.source }));
  expect(t.ok).toBe(true);
  trackItem(ctx, t.data.item.id);

  return { sourceId: s.data.item.id, targetId: t.data.item.id };
}

describe("edges.bulk", () => {
  it("creates edges in bulk and returns per-edge outcomes", async () => {
    const a = await makePair();
    const b = await makePair();

    const res = await client.bulkEdges({
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
    expect(res.ok).toBe(true);
    await expectMatchesSchema("POST", "/edges/bulk", 200, res.data);
    expect(res.data.counts.created).toBe(2);
    expect(res.data.counts.errored).toBe(0);
    expect(res.data.results).toHaveLength(2);
    for (const entry of res.data.results) {
      expect(entry.outcome).toBe("created");
      expect(entry.id).toBeDefined();
      trackEdge(ctx, entry.id!);
    }
  });

  it("upsert mode replaces properties in place on duplicate triples", async () => {
    const { sourceId, targetId } = await makePair();

    const first = await client.bulkEdges({
      edges: [
        {
          source_id: sourceId,
          target_id: targetId,
          edge_type: "about",
          properties: { weight: 1 },
        },
      ],
    });
    expect(first.ok).toBe(true);
    expect(first.data.counts.created).toBe(1);
    const originalId = first.data.results[0]!.id!;

    const second = await client.bulkEdges({
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
    expect(second.ok).toBe(true);
    expect(second.data.counts.updated).toBe(1);
    expect(second.data.counts.created).toBe(0);
    expect(second.data.results[0]!.id).toBe(originalId);

    // Verify property replace persisted. No GET /edges/:id route — hydrate
    // via the source item's outbound edge listing.
    const listRes = await client.listItemEdges(sourceId, {
      edge_type: "about",
    });
    expect(listRes.ok).toBe(true);
    const hit = listRes.data.data.find((e) => e.id === originalId);
    expect((hit?.properties as { weight?: number })?.weight).toBe(99);
  });

  it("create_only surfaces duplicates as skipped with reason duplicate_edge", async () => {
    const { sourceId, targetId } = await makePair();

    const first = await client.bulkEdges({
      edges: [
        {
          source_id: sourceId,
          target_id: targetId,
          edge_type: "about",
        },
      ],
      mode: "create_only",
    });
    expect(first.ok).toBe(true);
    expect(first.data.counts.created).toBe(1);

    const second = await client.bulkEdges({
      edges: [
        {
          source_id: sourceId,
          target_id: targetId,
          edge_type: "about",
          properties: { should_not_apply: true },
        },
      ],
      mode: "create_only",
    });
    expect(second.ok).toBe(true);
    expect(second.data.counts.skipped).toBe(1);
    expect(second.data.counts.created).toBe(0);
    expect(second.data.results[0]!.outcome).toBe("skipped");
    expect(second.data.results[0]!.reason).toBe("duplicate_edge");
  });

  it("matches an entry to the edge an earlier entry of the same request wrote", async () => {
    for (const atomic of [true, false]) {
      const { sourceId, targetId } = await makePair();
      const triple = { source_id: sourceId, target_id: targetId };
      const res = await client.bulkEdges({
        atomic,
        edges: [
          { ...triple, edge_type: "about", properties: { weight: 1 } },
          { ...triple, edge_type: "about", properties: { rank: 2 } },
        ],
      });
      expect(res.ok, `atomic ${String(atomic)}`).toBe(true);
      const [created, updated] = res.data.results;
      expect(created?.outcome).toBe("created");
      expect(updated?.outcome).toBe("updated");
      expect(updated?.id).toBe(created?.id);
      trackEdge(ctx, created!.id!);

      const listed = await client.listItemEdges(sourceId, {
        edge_type: "about",
      });
      expect(listed.ok).toBe(true);
      expect(listed.data.data).toHaveLength(1);
      expect(listed.data.data[0]?.properties).toEqual({ weight: 1, rank: 2 });

      const skipped = await client.bulkEdges({
        atomic,
        mode: "create_only",
        edges: [
          { ...triple, edge_type: "references" },
          { ...triple, edge_type: "references" },
        ],
      });
      expect(skipped.ok).toBe(true);
      expect(skipped.data.results[0]?.outcome).toBe("created");
      trackEdge(ctx, skipped.data.results[0]!.id!);
      expect(skipped.data.results[1]).toMatchObject({
        outcome: "skipped",
        reason: "duplicate_edge",
        id: skipped.data.results[0]?.id,
      });
    }
  });

  it("atomic=true rolls back the whole batch on validation error", async () => {
    const a = await makePair();

    const res = await client.bulkEdges({
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
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("bulk_atomic_rollback");

    // The first edge must not have been persisted — rollback verified.
    const listRes = await client.listItemEdges(a.sourceId, {
      edge_type: "about",
    });
    expect(listRes.ok).toBe(true);
    expect(listRes.data.data).toHaveLength(0);
  });

  it("atomic=true rolls back a batch naming an item that does not exist", async () => {
    const a = await makePair();
    const control = await makePair();

    // The rollback is asserted as an absence, so the listing has to be shown
    // to return something first — an edge made outside the batch.
    const outside = await client.createEdge({
      source_id: a.sourceId,
      target_id: control.targetId,
      edge_type: "about",
    });
    expect(outside.status).toBe(201);
    trackEdge(ctx, outside.data.edge.id);

    const res = await client.bulkEdges({
      edges: [
        {
          source_id: a.sourceId,
          target_id: a.targetId,
          edge_type: "about",
        },
        {
          source_id: a.sourceId,
          target_id: "00000000-0000-7000-8000-000000000000",
          edge_type: "about",
        },
      ],
      atomic: true,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error?.error.code).toBe("bulk_atomic_rollback");
    expect(res.error?.error.details?.code).toBe("item_not_found");

    const listRes = await client.listItemEdges(a.sourceId, {
      edge_type: "about",
    });
    expect(listRes.ok).toBe(true);
    const targets = listRes.data.data.map((e) => e.target_id);
    expect(targets).toEqual([control.targetId]);
  });

  it("atomic=false collects errors and continues", async () => {
    const a = await makePair();
    const b = await makePair();

    const res = await client.bulkEdges({
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
    });
    expect(res.ok).toBe(true);
    expect(res.data.counts.created).toBe(2);
    expect(res.data.counts.errored).toBe(1);
    expect(res.data.results[1]!.outcome).toBe("errored");
    expect(res.data.results[1]!.error?.code).toBe("invalid_id");
  });

  it("unknown edge_type lands as errored in non-atomic mode", async () => {
    const { sourceId, targetId } = await makePair();
    const res = await client.bulkEdges({
      edges: [
        {
          source_id: sourceId,
          target_id: targetId,
          edge_type: "nonexistent-edge-type",
        },
      ],
      atomic: false,
    });
    expect(res.ok).toBe(true);
    expect(res.data.counts.errored).toBe(1);
    expect(res.data.results[0]!.error?.code).toBe("edge_type_not_found");
  });

  it("gates bulk edges per type and edge permission, and on nothing else", async () => {
    // A key may bulk-write edges it holds permission for. POST /edges/bulk
    // authorizes per edge — write on the source item's type plus write on the
    // edge type — and consults nothing else about the credential. A key with
    // both write maps succeeds.
    const okKey = await client.createKey({
      label: "edges-bulk-writer",
      source: `${ctx.source}-writer`,
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    });
    expect(okKey.ok).toBe(true);
    trackKey(ctx, okKey.data.id);
    const writer = new MarfaClient({ baseUrl: apiUrl, apiKey: okKey.data.key });

    const a = await makePair();
    const ok = await writer.bulkEdges({
      edges: [
        { source_id: a.sourceId, target_id: a.targetId, edge_type: "about" },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.data.counts.created).toBe(1);

    // A key holding type write but no edge write is denied at the
    // per-edge gate. In atomic mode the batch rolls back with the inner
    // edge_permission_denied.
    const deniedKey = await client.createKey({
      label: "edges-bulk-denied",
      source: `${ctx.source}-denied`,
      type_permissions: { "*": "write" },
    });
    expect(deniedKey.ok).toBe(true);
    trackKey(ctx, deniedKey.data.id);
    const denied = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: deniedKey.data.key,
    });

    const b = await makePair();
    const rejected = await denied.bulkEdges({
      edges: [
        { source_id: b.sourceId, target_id: b.targetId, edge_type: "about" },
      ],
    });
    expect(rejected.ok).toBe(false);
    // `403`, as on the item door beside it: the batch was refused for a
    // permission the caller does not hold, and a `400` files that under
    // "fix the request".
    expect(rejected.status).toBe(403);
    expect(rejected.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rejected.error?.error.details?.code).toBe("edge_permission_denied");

    // Still a rollback: nothing of the page landed.
    const listed = await client.listItemEdges(b.sourceId, {
      edge_type: "about",
    });
    expect(listed.ok).toBe(true);
    expect(listed.data.data).toHaveLength(0);
  });

  it("refuses a reused edge id here as the single door does, and says what differs", async () => {
    // The code a caller gets for one mistake must not depend on how many
    // edges it batched, and neither must what the refusal tells it: a
    // per-entry error that carried only a code and a message left an
    // `id_reused` entry naming the mistake and not what to do about it.
    const first = await makePair();
    const second = await makePair();
    const id = uuidv7();

    const seeded = await client.createEdge({
      id,
      source_id: first.sourceId,
      target_id: first.targetId,
      edge_type: "about",
    });
    expect(seeded.ok, JSON.stringify(seeded.error)).toBe(true);
    trackEdge(ctx, id);

    const collision = await client.bulkEdges({
      edges: [
        {
          id,
          source_id: second.sourceId,
          target_id: second.targetId,
          edge_type: "about",
        },
      ],
      atomic: false,
    });
    expect(collision.ok).toBe(true);
    const entry = collision.data.results[0];
    expect(entry.outcome).toBe("errored");
    expect(entry.error?.code).toBe("id_reused");
    expect(entry.error?.details?.differs).toEqual(["source_id", "target_id"]);

    // Under the default `atomic` the page rolls back at the refusal's 409.
    const rolledBack = await client.bulkEdges({
      edges: [
        {
          id,
          source_id: second.sourceId,
          target_id: second.targetId,
          edge_type: "about",
        },
      ],
    });
    expect(rolledBack.status).toBe(409);
    expect(rolledBack.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rolledBack.error?.error.details?.code).toBe("id_reused");

    // The witness: the same entry under an id nothing holds lands, so the
    // refusal is the id rather than the triple or the door.
    const accepted = await client.bulkEdges({
      edges: [
        {
          source_id: second.sourceId,
          target_id: second.targetId,
          edge_type: "about",
        },
      ],
      atomic: false,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.data.results[0].outcome).toBe("created");
    const madeId = accepted.data.results[0].id;
    if (madeId) trackEdge(ctx, madeId);
  });
});
