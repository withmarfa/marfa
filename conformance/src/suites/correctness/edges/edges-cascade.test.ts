import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  cleanup,
} from "../../../utils/setup.js";
import { createNote } from "../../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "edges-cascade"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(label: string = ""): Promise<string> {
  const r = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { body: `cascade-${label}` },
    }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("edge cascade semantics", () => {
  it("deleting a parent-of parent cascades to children", async () => {
    const parent = await makeItem("parent");
    const child = await makeItem("child");

    const edge = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const del = await client.deleteItem(parent);
    expect(del.ok).toBe(true);

    // The child is trashed with its parent: hidden from a direct read and
    // present in the trashed listing.
    const fetched = await client.getItem(child);
    expect(fetched.status).toBe(404);
    const trashed = await client.listItems({
      source: ctx.source,
      state: "trashed",
      limit: 100,
    });
    expect(trashed.ok).toBe(true);
    expect(trashed.data.data.map((i) => i.id)).toContain(child);
  });

  it("supersedes defaults to orphan: deleting head leaves predecessor intact", async () => {
    const predecessor = await makeItem("pred");
    const head = await makeItem("head");

    const edge = await client.createEdge({
      source_id: head,
      target_id: predecessor,
      edge_type: "supersedes",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const del = await client.deleteItem(head);
    expect(del.ok).toBe(true);

    const fetched = await client.getItem(predecessor);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.state).toBe("active");
  });

  it("about defaults to orphan: deleting source leaves target intact", async () => {
    const source = await makeItem("about-src");
    const target = await makeItem("about-tgt");

    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const del = await client.deleteItem(source);
    expect(del.ok).toBe(true);

    const fetched = await client.getItem(target);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.state).toBe("active");
  });

  it("attached-to defaults to orphan: deleting the host leaves the attachment intact", async () => {
    // attached-to direction: source = attachment, target = host.
    const attachment = await makeItem("attachment");
    const host = await makeItem("host");

    const edge = await client.createEdge({
      source_id: attachment,
      target_id: host,
      edge_type: "attached-to",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const del = await client.deleteItem(host);
    expect(del.ok).toBe(true);

    const fetched = await client.getItem(attachment);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.state).toBe("active");
  });

  it("references defaults to orphan: deleting the referenced target leaves the source intact", async () => {
    const source = await makeItem("ref-src");
    const target = await makeItem("ref-tgt");

    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "references",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const del = await client.deleteItem(target);
    expect(del.ok).toBe(true);

    const fetched = await client.getItem(source);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.state).toBe("active");
  });

  it("custom edge-type with cascade_on_delete=cascade cascades on source delete", async () => {
    const etId = `mock.cascade.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      cascade_on_delete: "cascade",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const source = await makeItem("cc-src");
    const target = await makeItem("cc-tgt");

    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: etId,
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const del = await client.deleteItem(source);
    expect(del.ok).toBe(true);

    const fetched = await client.getItem(target);
    expect(fetched.status).toBe(404);
    const trashed = await client.listItems({
      source: ctx.source,
      state: "trashed",
      limit: 100,
    });
    expect(trashed.ok).toBe(true);
    expect(trashed.data.data.map((i) => i.id)).toContain(target);
  });

  it("custom edge-type with cascade_on_delete=block refuses source delete while edges exist", async () => {
    const etId = `mock.block.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const source = await makeItem("bl-src");
    const target = await makeItem("bl-tgt");

    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: etId,
    });
    expect(edge.ok).toBe(true);
    const edgeId = edge.data.edge.id;
    trackEdge(ctx, edgeId);

    const del = await client.deleteItem(source);
    expect(del.status).toBe(400);
    expect(del.error?.error.code).toBe("edge_constraint_violation");
    expect(
      (del.error?.error.details?.blocking_edges as Array<{ id: string }>).map(
        (e) => e.id,
      ),
    ).toEqual([edgeId]);

    await client.deleteEdge(edgeId);
    const del2 = await client.deleteItem(source);
    expect(del2.ok).toBe(true);
  });
});
