import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../../utils/setup.js";
import { createNote } from "../../../generators/items.js";
import { expectMatchesSchema } from "../../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "edges-crud"));
});

afterAll(async () => {
  await cleanup(ctx);
});

const CORE_EDGE_TYPES = [
  "about",
  "parent-of",
  "in-thread",
  "attached-to",
  "authored-by",
  "derived-from",
  "supersedes",
  "references",
] as const;

async function makeItem(): Promise<string> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("edges CRUD", () => {
  for (const edgeType of CORE_EDGE_TYPES) {
    it(`creates a ${edgeType} edge and reads it back via listItemEdges`, async () => {
      const sourceId = await makeItem();
      const targetId = await makeItem();

      const created = await client.createEdge({
        source_id: sourceId,
        target_id: targetId,
        edge_type: edgeType,
      });
      expect(created.status).toBe(201);
      trackEdge(ctx, created.data.edge.id);
      await expectMatchesSchema("POST", "/edges", 201, created.data);
      expect(created.data.edge.edge_type).toBe(edgeType);
      expect(created.data.edge.source_id).toBe(sourceId);
      expect(created.data.edge.target_id).toBe(targetId);
      expect(created.data.edge.version).toBe(1);
      expect(typeof created.data.edge.created_at).toBe("string");
      expect(typeof created.data.edge.updated_at).toBe("string");
      expect(created.data.edge.properties).toEqual({});

      const outbound = await client.listItemEdges(sourceId, {
        edge_type: edgeType,
      });
      expect(outbound.ok).toBe(true);
      const edgeIds = outbound.data.data.map((e) => e.id);
      expect(edgeIds).toContain(created.data.edge.id);
    });
  }

  it("updateEdge patches properties only", async () => {
    const sourceId = await makeItem();
    const targetId = await makeItem();

    const created = await client.createEdge({
      source_id: sourceId,
      target_id: targetId,
      edge_type: "about",
      properties: { note: "initial", position: 1 },
    });
    expect(created.ok).toBe(true);
    trackEdge(ctx, created.data.edge.id);

    const updated = await client.updateEdge(created.data.edge.id, {
      properties: { note: "updated", position: 2 },
    });
    expect(updated.status).toBe(200);
    await expectMatchesSchema("PATCH", "/edges/{id}", 200, updated.data);
    expect(updated.data.edge.properties).toEqual({
      note: "updated",
      position: 2,
    });
    expect(updated.data.edge.source_id).toBe(sourceId);
    expect(updated.data.edge.target_id).toBe(targetId);
    expect(updated.data.edge.edge_type).toBe("about");
  });

  it("updateEdge merges over the properties it was not given", async () => {
    // The case above names every property it wrote, so it agrees whether the
    // door merges or replaces. This one names one of two.
    //
    // A replacing door drops the property the patch does not mention, and
    // nothing reports it: the write is accepted, the response is a 200, and a
    // client whose own projection merges goes on showing the value the server
    // has just discarded until some later read corrects it.
    const sourceId = await makeItem();
    const targetId = await makeItem();

    const created = await client.createEdge({
      source_id: sourceId,
      target_id: targetId,
      edge_type: "about",
      properties: { note: "kept", position: 1 },
    });
    expect(created.ok).toBe(true);
    trackEdge(ctx, created.data.edge.id);

    const updated = await client.updateEdge(created.data.edge.id, {
      properties: { position: 2 },
    });
    expect(updated.ok).toBe(true);
    expect(updated.data.edge.properties).toEqual({
      note: "kept",
      position: 2,
    });

    // Read back rather than trusting the write's own answer. A server that
    // returned a merged body while storing a replaced row would satisfy the
    // assertion above and fail this one. Through the source item's outbound
    // listing, which is the read this suite's client already has for an edge.
    const read = await client.listItemEdges(sourceId, { edge_type: "about" });
    expect(read.ok).toBe(true);
    const stored = read.data.data.find((e) => e.id === created.data.edge.id);
    expect(stored?.properties).toEqual({ note: "kept", position: 2 });
  });

  it("deleteEdge removes the edge; subsequent list excludes it", async () => {
    const sourceId = await makeItem();
    const targetId = await makeItem();

    const otherTarget = await makeItem();
    const created = await client.createEdge({
      source_id: sourceId,
      target_id: targetId,
      edge_type: "about",
    });
    expect(created.ok).toBe(true);
    const edgeId = created.data.edge.id;
    const kept = await client.createEdge({
      source_id: sourceId,
      target_id: otherTarget,
      edge_type: "about",
    });
    expect(kept.ok).toBe(true);
    trackEdge(ctx, kept.data.edge.id);

    const del = await client.deleteEdge(edgeId);
    expect(del.status).toBe(200);
    await expectMatchesSchema("DELETE", "/edges/{id}", 200, del.data);

    const after = await client.listItemEdges(sourceId, { edge_type: "about" });
    expect(after.ok).toBe(true);
    const ids = after.data.data.map((e) => e.id);
    expect(ids).toContain(kept.data.edge.id);
    expect(ids).not.toContain(edgeId);
  });

  it("rejects POST /edges missing required fields", async () => {
    const target = await makeItem();

    const noSource = await client.createEdge({
      source_id: undefined as unknown as string,
      target_id: target,
      edge_type: "about",
    });
    expect(noSource.ok).toBe(false);
    expect(noSource.status).toBe(400);
    expect(noSource.error?.error.code).toBe("missing_required_field");

    const src = await makeItem();
    const noTarget = await client.createEdge({
      source_id: src,
      target_id: undefined as unknown as string,
      edge_type: "about",
    });
    expect(noTarget.ok).toBe(false);
    expect(noTarget.status).toBe(400);
    expect(noTarget.error?.error.code).toBe("missing_required_field");
  });

  it("POST /items with edges creates item + edges atomically", async () => {
    const aboutTarget = await makeItem();
    const parentTarget = await makeItem();

    const created = await client.createItem({
      type: "core.note",
      properties: { title: "atomic", body: "with-edges" },
      edges: {
        about: [aboutTarget],
        "parent-of": [parentTarget],
      },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    const hydrated = created.data.item.edges;
    expect(hydrated).toBeDefined();
    expect(hydrated!.about.edges.length).toBe(1);
    expect(hydrated!.about.edges[0].target_id).toBe(aboutTarget);
    expect(hydrated!["parent-of"].edges.length).toBe(1);
    expect(hydrated!["parent-of"].edges[0].target_id).toBe(parentTarget);

    const list = await client.listItemEdges(created.data.item.id);
    expect(list.ok).toBe(true);
    for (const edge of list.data.data) {
      trackEdge(ctx, edge.id);
    }
  });

  it("PATCH /items with edges replaces edges of specified types only", async () => {
    const aboutA = await makeItem();
    const aboutB = await makeItem();
    const parentTarget = await makeItem();

    const created = await client.createItem({
      type: "core.note",
      properties: { body: "patch-target" },
      edges: {
        about: [aboutA],
        "parent-of": [parentTarget],
      },
    });
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    for (const edge of Object.values(created.data.item.edges ?? {}).flatMap(
      (section) => section.edges,
    )) {
      trackEdge(ctx, edge.id);
    }

    const patched = await client.updateItem(itemId, {
      edges: { about: [aboutB] },
    });
    expect(patched.ok).toBe(true);

    const all = await client.listItemEdges(itemId);
    expect(all.ok).toBe(true);
    const byType: Record<string, string[]> = {};
    for (const edge of all.data.data) {
      byType[edge.edge_type] = byType[edge.edge_type] ?? [];
      byType[edge.edge_type].push(edge.target_id);
      trackEdge(ctx, edge.id);
    }

    expect(byType["about"]).toEqual([aboutB]);
    expect(byType["parent-of"]).toEqual([parentTarget]);
  });
});
