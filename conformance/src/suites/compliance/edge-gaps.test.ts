/**
 * Answers of `POST /edges` and `GET /items/{id}/backrefs` that no other
 * fixture pins.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "edge-gaps"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function note(): Promise<string> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("POST /edges", () => {
  it("refuses a request with no edge type as missing_required_field", async () => {
    const source = await note();
    const target = await note();
    const refused = await client.rawRequest("/edges", {
      method: "POST",
      body: { source_id: source, target_id: target },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("missing_required_field");

    // The witness: the same body with an edge type lands.
    const made = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(made.status).toBe(201);
    trackEdge(ctx, made.data.edge.id);
  });

  it("answers a target in the bin as item_not_found", async () => {
    const source = await note();
    const target = await note();

    // The witness: the same edge lands while the target is live.
    const live = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(live.status).toBe(201);
    trackEdge(ctx, live.data.edge.id);

    const other = await note();
    expect((await client.deleteItem(other)).status).toBe(200);
    const gone = await client.createEdge({
      source_id: source,
      target_id: other,
      edge_type: "about",
    });
    expect(gone.status).toBe(404);
    expect(gone.error?.error.code).toBe("item_not_found");
  });
});

describe("GET /items/{id}/backrefs", () => {
  it("takes a limit of 500 and refuses 501 and 0", async () => {
    const target = await note();
    const source = await note();
    const made = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(made.status).toBe(201);
    trackEdge(ctx, made.data.edge.id);

    const widest = await client.listItemBackrefs(target, { limit: 500 });
    expect(widest.status).toBe(200);
    expect(widest.data.data.map((e) => e.id)).toEqual([made.data.edge.id]);

    for (const limit of [501, 0]) {
      const refused = await client.listItemBackrefs(target, { limit });
      expect(refused.status, `limit ${String(limit)}`).toBe(400);
      expect(refused.error?.error.code, `limit ${String(limit)}`).toBe(
        "validation_error",
      );
    }
  });

  it("takes 10 edge types and refuses 11", async () => {
    const target = await note();
    const source = await note();
    const made = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(made.status).toBe(201);
    trackEdge(ctx, made.data.edge.id);

    const types = (count: number): string =>
      [
        "about",
        ...Array.from(
          { length: count - 1 },
          (_, i) => `mock.backref-filter-${String(i)}`,
        ),
      ].join(",");

    const ten = await client.listItemBackrefs(target, { edge_type: types(10) });
    expect(ten.status).toBe(200);
    expect(ten.data.data.map((e) => e.id)).toEqual([made.data.edge.id]);

    const eleven = await client.listItemBackrefs(target, {
      edge_type: types(11),
    });
    expect(eleven.status).toBe(400);
    expect(eleven.error?.error.code).toBe("validation_error");
  });
});
