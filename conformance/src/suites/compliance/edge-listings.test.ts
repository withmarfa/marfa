import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaEdge, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "edge-listings"));
});

afterAll(async () => {
  await cleanup(ctx);
});

const MAX_LIMIT = 500;
const MAX_EDGE_TYPES = 10;
const SHIPPED_EDGE_TYPES = [
  "about",
  "parent-of",
  "in-thread",
  "attached-to",
  "authored-by",
  "derived-from",
  "supersedes",
  "references",
  "in-collection",
  "in-folder",
];

async function makeItem(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `el-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function registerEdgeType(label: string): Promise<string> {
  const id = `mock.${label}.${ctx.runId}`;
  const reg = await client.registerEdgeType({
    id,
    cardinality: "many-to-many",
  });
  expect(reg.status, JSON.stringify(reg.error)).toBe(201);
  trackEdgeType(ctx, id);
  return id;
}

async function makeEdge(
  source: string,
  target: string,
  edgeType: string,
): Promise<MarfaEdge> {
  const r = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge;
}

describe("the edge listings", () => {
  it("takes a limit of 500 and refuses 501 and 0, on both listings", async () => {
    const edgeType = await registerEdgeType("limit");
    const source = await makeItem("limit-source");
    const seeded = await client.bulkItems({
      items: Array.from({ length: MAX_LIMIT + 1 }, (_, i) => ({
        type: "core.note",
        source: ctx.source,
        properties: { body: `el-limit-target-${String(i)}` },
      })),
    });
    expect(seeded.status, JSON.stringify(seeded.error)).toBe(200);
    const targets = seeded.data.results.map((r) => String(r.id));
    for (const id of targets) trackItem(ctx, id);
    const edges = await client.bulkEdges({
      edges: targets.map((target) => ({
        source_id: source,
        target_id: target,
        edge_type: edgeType,
      })),
    });
    expect(edges.status, JSON.stringify(edges.error)).toBe(200);
    expect(edges.data.counts.created).toBe(MAX_LIMIT + 1);

    const doors: {
      name: string;
      list: (limit: number) => ReturnType<MarfaClient["listEdges"]>;
    }[] = [
      {
        name: "GET /edges",
        list: (limit) => client.listEdges({ edge_type: edgeType, limit }),
      },
      {
        name: "GET /items/{id}/edges",
        list: (limit) =>
          client.listItemEdges(source, { edge_type: edgeType, limit }),
      },
    ];
    for (const door of doors) {
      // More edges are held than the largest page, so a page of 500 is the
      // limit honored and not the listing running out.
      const widest = await door.list(MAX_LIMIT);
      expect(widest.status, door.name).toBe(200);
      expect(widest.data.data, door.name).toHaveLength(MAX_LIMIT);
      expect(widest.data.next_cursor, door.name).not.toBeNull();

      const narrowest = await door.list(1);
      expect(narrowest.status, door.name).toBe(200);
      expect(narrowest.data.data, door.name).toHaveLength(1);

      for (const limit of [MAX_LIMIT + 1, 0]) {
        const refused = await door.list(limit);
        expect(refused.status, `${door.name} limit ${String(limit)}`).toBe(400);
        expect(refused.error?.error.code, door.name).toBe("validation_error");
        expect(
          refused.error?.error.details?.errors,
          `${door.name} limit ${String(limit)}`,
        ).toMatchObject([{ path: "limit" }]);
      }
    }
  });

  it("takes an edge_type filter of 10 types and refuses one of 11, on both listings", async () => {
    const extra = await registerEdgeType("filter");
    const source = await makeItem("filter-source");
    const target = await makeItem("filter-target");
    const aboutEdge = await makeEdge(source, target, "about");
    const extraEdge = await makeEdge(source, target, extra);

    const ten = SHIPPED_EDGE_TYPES.join(",");
    const eleven = [...SHIPPED_EDGE_TYPES, extra].join(",");
    expect(SHIPPED_EDGE_TYPES).toHaveLength(MAX_EDGE_TYPES);

    const fromSource = await client.listItemEdges(source, { edge_type: ten });
    expect(fromSource.status).toBe(200);
    // The edge of the type left out of the ten is the control: the filter
    // narrows, so it is not there.
    expect(fromSource.data.data.map((e) => e.id)).toEqual([aboutEdge.id]);

    const all = await client.listEdges({ edge_type: ten, limit: MAX_LIMIT });
    expect(all.status).toBe(200);
    const ids = all.data.data.map((e) => e.id);
    expect(ids).toContain(aboutEdge.id);
    expect(ids).not.toContain(extraEdge.id);

    const overSource = await client.listItemEdges(source, {
      edge_type: eleven,
    });
    expect(overSource.status).toBe(400);
    expect(overSource.error?.error.code).toBe("validation_error");

    const overAll = await client.listEdges({ edge_type: eleven });
    expect(overAll.status).toBe(400);
    expect(overAll.error?.error.code).toBe("validation_error");

    // The eleventh name is a registered type, so the refusals above are the
    // count and not the name.
    const alone = await client.listItemEdges(source, { edge_type: extra });
    expect(alone.data.data.map((e) => e.id)).toEqual([extraEdge.id]);
  });

  it("lists edges newest created first, and an update does not move one", async () => {
    const edgeType = await registerEdgeType("order");
    const source = await makeItem("order-source");
    const created: MarfaEdge[] = [];
    for (let i = 0; i < 3; i++) {
      const target = await makeItem(`order-target-${String(i)}`);
      created.push(await makeEdge(source, target, edgeType));
    }
    const newestFirst = created.map((e) => e.id).reverse();

    const updated = await client.updateEdge(created[0]!.id, {
      properties: { touched: true },
      version: created[0]!.version,
    });
    expect(updated.status).toBe(200);

    const all = await client.listEdges({ edge_type: edgeType });
    expect(all.status).toBe(200);
    expect(all.data.data.map((e) => e.id)).toEqual(newestFirst);

    const fromSource = await client.listItemEdges(source, {
      edge_type: edgeType,
    });
    expect(fromSource.status).toBe(200);
    expect(fromSource.data.data.map((e) => e.id)).toEqual(newestFirst);
  });
});

describe("the edges of an item in the bin", () => {
  it("stay readable by id and listed, whichever end is in the bin", async () => {
    const edgeType = await registerEdgeType("bin");
    const sourceInBin = await makeItem("bin-source-a");
    const targetLive = await makeItem("bin-target-a");
    const sourceLive = await makeItem("bin-source-b");
    const targetInBin = await makeItem("bin-target-b");
    const fromBin = await makeEdge(sourceInBin, targetLive, edgeType);
    const toBin = await makeEdge(sourceLive, targetInBin, edgeType);

    // The witness: both are listed and readable while their items are live.
    const before = await client.listEdges({
      edge_type: edgeType,
      limit: MAX_LIMIT,
    });
    expect(before.data.data.map((e) => e.id).sort()).toEqual(
      [fromBin.id, toBin.id].sort(),
    );

    expect((await client.deleteItem(sourceInBin)).ok).toBe(true);
    expect((await client.deleteItem(targetInBin)).ok).toBe(true);
    expect((await client.getItem(sourceInBin)).status).toBe(404);

    for (const edge of [fromBin, toBin]) {
      const read = await client.getEdge(edge.id);
      expect(read.status, edge.id).toBe(200);
      expect(read.data.edge).toEqual(edge);
    }
    const after = await client.listEdges({
      edge_type: edgeType,
      limit: MAX_LIMIT,
    });
    expect(after.data.data.map((e) => e.id).sort()).toEqual(
      [fromBin.id, toBin.id].sort(),
    );

    const outbound = await client.listItemEdges(sourceInBin);
    expect(outbound.data.data.map((e) => e.id)).toEqual([fromBin.id]);
    const inbound = await client.listItemBackrefs(targetInBin);
    expect(inbound.data.data.map((e) => e.id)).toEqual([toBin.id]);
  });
});
