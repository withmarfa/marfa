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
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "correctness",
    "edges-list",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function seedItem(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `el-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function seedEdge(source: string, target: string, edgeType: string) {
  const r = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(r.ok).toBe(true);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge;
}

describe("edge listing and reads", () => {
  it("reads an edge by id with its version", async () => {
    const a = await seedItem("read-a");
    const b = await seedItem("read-b");
    const created = await seedEdge(a, b, "about");

    const r = await client.getEdge(created.id);
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/edges/{id}", 200, r.data);
    expect(r.data.edge.id).toBe(created.id);
    expect(r.data.edge.source_id).toBe(a);
    expect(r.data.edge.target_id).toBe(b);
    expect(r.data.edge.edge_type).toBe("about");
    expect(r.data.edge.version).toBe(1);
  });

  it("lists edges by type, excluding other types", async () => {
    const a = await seedItem("list-a");
    const b = await seedItem("list-b");
    const about = await seedEdge(a, b, "about");
    const references = await seedEdge(a, b, "references");

    const r = await client.listEdges({ edge_type: "about", limit: 500 });
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/edges", 200, r.data);
    const ids = r.data.data.map((e) => e.id);
    expect(ids).toContain(about.id);
    expect(ids).not.toContain(references.id);
    for (const edge of r.data.data) expect(edge.edge_type).toBe("about");
  });

  it("bounds a listing by updated_after with an excluded control", async () => {
    const a = await seedItem("time-a");
    const b = await seedItem("time-b");
    const older = await seedEdge(a, b, "about");
    const boundary = new Date(Date.parse(older.updated_at) + 1).toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const newer = await seedEdge(b, a, "about");

    const r = await client.listEdges({
      edge_type: "about",
      updated_after: boundary,
      limit: 500,
    });
    expect(r.ok).toBe(true);
    const ids = r.data.data.map((e) => e.id);
    expect(ids).toContain(newer.id);
    expect(ids).not.toContain(older.id);
  });

  it("paginates with a cursor and delivers every edge once", async () => {
    const a = await seedItem("page-a");
    const targets = await Promise.all(
      Array.from({ length: 5 }, (_, i) => seedItem(`page-t${String(i)}`)),
    );
    const mine = new Set<string>();
    for (const t of targets) mine.add((await seedEdge(a, t, "references")).id);

    const delivered: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await client.listEdges({
        edge_type: "references",
        limit: 2,
        cursor,
      });
      expect(r.ok).toBe(true);
      expect(r.data.data.length).toBeLessThanOrEqual(2);
      delivered.push(...r.data.data.map((e) => e.id));
      if (r.data.next_cursor === null) break;
      cursor = r.data.next_cursor ?? undefined;
    }
    const ours = delivered.filter((id) => mine.has(id));
    expect(ours).toHaveLength(5);
    expect(new Set(ours).size).toBe(5);
  });

  it("refuses an unknown query key and an unknown edge id", async () => {
    const unknownKey = await client.rawRequest("/edges?zzz_not_a_parameter=1");
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.error?.error.code).toBe("validation_error");
    expect(unknownKey.error?.error.details?.unknown_parameters).toEqual([
      "zzz_not_a_parameter",
    ]);
    const unknownId = await client.getEdge(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(unknownId.status).toBe(404);
    expect(unknownId.error?.error.code).toBe("edge_not_found");
  });

  it("refuses a listing with no credential", async () => {
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    expect((await anonymous.listEdges()).status).toBe(401);
  });
});
