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
  ({ ctx, client } = await createTestContext("correctness", "edges-backrefs"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(label: string = ""): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `br-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("edge backrefs", () => {
  it("GET /items/:id/backrefs returns inbound edges", async () => {
    const target = await makeItem("br-target");
    const srcA = await makeItem("srcA");
    const srcB = await makeItem("srcB");

    const eA = await client.createEdge({
      source_id: srcA,
      target_id: target,
      edge_type: "about",
    });
    expect(eA.ok).toBe(true);
    trackEdge(ctx, eA.data.edge.id);
    const eB = await client.createEdge({
      source_id: srcB,
      target_id: target,
      edge_type: "authored-by",
    });
    expect(eB.ok).toBe(true);
    trackEdge(ctx, eB.data.edge.id);

    const back = await client.listItemBackrefs(target);
    expect(back.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}/backrefs", 200, back.data);
    const edgeIds = back.data.data.map((e) => e.id);
    expect(edgeIds).toContain(eA.data.edge.id);
    expect(edgeIds).toContain(eB.data.edge.id);
  });

  it("?edge_type filter narrows to one type", async () => {
    const target = await makeItem("filt-target");
    const s1 = await makeItem("s1");
    const s2 = await makeItem("s2");

    const about = await client.createEdge({
      source_id: s1,
      target_id: target,
      edge_type: "about",
    });
    expect(about.ok).toBe(true);
    trackEdge(ctx, about.data.edge.id);
    const authored = await client.createEdge({
      source_id: s2,
      target_id: target,
      edge_type: "authored-by",
    });
    expect(authored.ok).toBe(true);
    trackEdge(ctx, authored.data.edge.id);

    const filtered = await client.listItemBackrefs(target, {
      edge_type: "about",
    });
    expect(filtered.ok).toBe(true);
    expect(filtered.data.data.every((e) => e.edge_type === "about")).toBe(true);
    const ids = filtered.data.data.map((e) => e.id);
    expect(ids).toContain(about.data.edge.id);
    expect(ids).not.toContain(authored.data.edge.id);
  });

  it("paginates via cursor across many inbound edges", async () => {
    const target = await makeItem("paginated");
    for (let i = 0; i < 15; i++) {
      const src = await makeItem(`p-src-${i}`);
      const e = await client.createEdge({
        source_id: src,
        target_id: target,
        edge_type: "about",
      });
      expect(e.ok).toBe(true);
      trackEdge(ctx, e.data.edge.id);
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let iterations = 0;
    while (iterations++ < 10) {
      const page = await client.listItemBackrefs(target, {
        edge_type: "about",
        limit: 5,
        cursor,
      });
      expect(page.ok).toBe(true);
      for (const e of page.data.data) collected.push(e.id);
      if (!page.data.has_more || !page.data.cursor) break;
      cursor = page.data.cursor;
    }
    expect(collected.length).toBe(15);
    expect(new Set(collected).size).toBe(15);
  });

  it("answers 404 for an unknown item and 400 for a malformed id", async () => {
    const unknown = await client.listItemBackrefs(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("item_not_found");
    const malformed = await client.listItemBackrefs("not-an-id");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("invalid_id");
  });
});
