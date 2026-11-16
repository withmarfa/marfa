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
import { createNote, generateId } from "../../generators/items.js";

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
  "derived-from",
  "excerpt-of",
  "comments-on",
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
    label: "Test edge type",
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
    from_id: source,
    to_id: target,
    edge_type: edgeType,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge;
}

describe("the edge listings", () => {
  it("takes a limit of 500, reads 501 as 500 and refuses 0, on every edge listing", async () => {
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
        from_id: source,
        to_id: target,
        edge_type: edgeType,
      })),
    });
    expect(edges.status, JSON.stringify(edges.error)).toBe(200);
    expect(edges.data.counts.created).toBe(MAX_LIMIT + 1);
    const inbound = await registerEdgeType("limit-in");
    const backrefs = await client.bulkEdges({
      edges: targets.map((target) => ({
        from_id: target,
        to_id: source,
        edge_type: inbound,
      })),
    });
    expect(backrefs.status, JSON.stringify(backrefs.error)).toBe(200);
    expect(backrefs.data.counts.created).toBe(MAX_LIMIT + 1);

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
      {
        name: "GET /items/{id}/backrefs",
        list: (limit) =>
          client.listItemBackrefs(source, { edge_type: inbound, limit }),
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

      const over = await door.list(MAX_LIMIT + 1);
      expect(over.status, door.name).toBe(200);
      expect(over.data.data, door.name).toHaveLength(MAX_LIMIT);
      expect(over.data.next_cursor, door.name).not.toBeNull();

      const refused = await door.list(0);
      expect(refused.status, door.name).toBe(400);
      expect(refused.error?.error.code, door.name).toBe("validation_error");
      expect(refused.error?.error.details?.errors, door.name).toMatchObject([
        { path: "limit" },
      ]);
    }
  });

  it("takes an edge_type filter of 10 types and refuses one of 11, on both listings", async () => {
    const extra = await registerEdgeType("filter");
    const source = await makeItem("filter-source");
    const target = await makeItem("filter-target");
    const aboutEdge = await makeEdge(source, target, "about");
    const extraEdge = await makeEdge(source, target, extra);

    // Ten shipped names make the widest filter, whatever the number of
    // shipped types, so the eleventh name is a registered type.
    const shipped = SHIPPED_EDGE_TYPES.slice(0, MAX_EDGE_TYPES);
    expect(shipped).toContain("about");
    const ten = shipped.join(",");
    const eleven = [...shipped, extra].join(",");

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

describe("GET /edges with updated_after", () => {
  async function listedIds(query: {
    edge_type: string;
    updated_after: string;
    limit?: number;
  }): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listEdges({
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.status).toBe(200);
      ids.push(...page.data.data.map((e) => e.id));
      cursor = page.data.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return ids;
  }

  it("lists edges oldest change first by updated_at, so an update moves an edge to the end, and pages in that order", async () => {
    const edgeType = await registerEdgeType("changed");
    const source = await makeItem("changed-source");
    const created: MarfaEdge[] = [];
    for (let i = 0; i < 3; i++) {
      const target = await makeItem(`changed-target-${String(i)}`);
      created.push(await makeEdge(source, target, edgeType));
    }
    const since = new Date(
      Date.parse(created[0]!.created_at) - 60_000,
    ).toISOString();

    // Update the oldest edge until its change is later than every creation.
    let touched = created[0]!;
    for (let attempt = 0; attempt < 50; attempt++) {
      const updated = await client.updateEdge(touched.id, {
        properties: { touched: attempt },
        version: touched.version,
      });
      expect(updated.status).toBe(200);
      touched = updated.data.edge;
      if (touched.updated_at > created[2]!.updated_at) break;
    }
    expect(touched.updated_at > created[2]!.updated_at).toBe(true);

    // The witness: without updated_after the same edges list newest created
    // first.
    const byCreation = await client.listEdges({ edge_type: edgeType });
    expect(byCreation.data.data.map((e) => e.id)).toEqual(
      created.map((e) => e.id).reverse(),
    );

    const oldestChangeFirst = [created[1]!.id, created[2]!.id, created[0]!.id];
    expect(
      await listedIds({ edge_type: edgeType, updated_after: since }),
    ).toEqual(oldestChangeFirst);
    expect(
      await listedIds({ edge_type: edgeType, updated_after: since, limit: 1 }),
    ).toEqual(oldestChangeFirst);
  });

  it("lists edges that changed at the same time by ascending id", async () => {
    const edgeType = await registerEdgeType("tied");
    const source = await makeItem("tied-source");
    const ids = [generateId(), generateId(), generateId()].sort();
    const targets = [await makeItem("tied-a"), await makeItem("tied-b")];
    const third = await makeItem("tied-c");
    const made = await client.bulkEdges({
      edges: [ids[2]!, ids[0]!, ids[1]!].map((id, at) => ({
        id,
        from_id: source,
        to_id: [...targets, third][at]!,
        edge_type: edgeType,
      })),
    });
    expect(made.status, JSON.stringify(made.error)).toBe(200);
    expect(made.data.counts.created).toBe(3);
    for (const id of ids) trackEdge(ctx, id);

    const listed = await client.listEdges({
      edge_type: edgeType,
      updated_after: "1970-01-01T00:00:00Z",
    });
    expect(listed.status).toBe(200);
    // The witness: the three edges share one change time, so only the ID
    // orders them.
    expect(new Set(listed.data.data.map((e) => e.updated_at)).size).toBe(1);
    expect(listed.data.data.map((e) => e.id)).toEqual(ids);
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
