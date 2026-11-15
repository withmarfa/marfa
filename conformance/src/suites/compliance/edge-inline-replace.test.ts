import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let other: MarfaClient;
let edgeType: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-inline-replace",
  ));
  const minted = await client.createKey({
    label: "second writer",
    source: `${ctx.source}-second`,
    permissions: [],
    type_permissions: { "core.note": "write" },
    edge_permissions: { "*": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  other = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });

  edgeType = `mock.inline-replace.${ctx.runId}`;
  const registered = await client.registerEdgeType({
    label: "Test edge type",
    id: edgeType,
    cardinality: "many-to-many",
  });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  trackEdgeType(ctx, edgeType);
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

async function targetsOf(id: string): Promise<string[]> {
  const r = await client.listItemEdges(id, { edge_type: edgeType });
  expect(r.status).toBe(200);
  for (const edge of r.data.data) trackEdge(ctx, edge.id);
  return r.data.data.map((edge) => edge.target_id).sort();
}

describe("an edges list that replaces an item's edges of a type", () => {
  it("removes an edge another key added, and keeps the edges it lists", async () => {
    const listed = await note();
    const added = await note();
    const kept = await note();
    const sourceId = `inline-replace-${ctx.runId}`;
    const made = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        edges: { [edgeType]: [listed, kept] },
      }),
    );
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    const id = made.data.item.id;

    const second = await other.createEdge({
      source_id: id,
      target_id: added,
      edge_type: edgeType,
    });
    expect(second.status, JSON.stringify(second.error)).toBe(201);
    trackEdge(ctx, second.data.edge.id);
    // The witness: the edge another key added is one of the item's.
    expect(await targetsOf(id)).toEqual([added, kept, listed].sort());

    const patched = await client.updateItem(id, {
      version: made.data.item.version,
      edges: { [edgeType]: [listed, kept] },
    });
    expect(patched.status, JSON.stringify(patched.error)).toBe(200);
    expect(await targetsOf(id)).toEqual([kept, listed].sort());
    expect((await client.getEdge(second.data.edge.id)).status).toBe(404);

    // The same list through POST /items, landing on the item by its natural key.
    const again = await other.createEdge({
      source_id: id,
      target_id: added,
      edge_type: edgeType,
    });
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    trackEdge(ctx, again.data.edge.id);
    expect(await targetsOf(id)).toEqual([added, kept, listed].sort());
    const landed = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        edges: { [edgeType]: [listed, kept] },
      }),
    );
    expect(landed.status, JSON.stringify(landed.error)).toBe(200);
    expect(landed.data.item.id).toBe(id);
    expect(await targetsOf(id)).toEqual([kept, listed].sort());
  });
});
