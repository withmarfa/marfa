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

  it("restoring a parent brings back what its trash took, at every depth, and nothing trashed on its own", async () => {
    const parent = await makeItem("r-parent");
    const child = await makeItem("r-child");
    const grandchild = await makeItem("r-grandchild");
    const alone = await makeItem("r-alone");
    for (const [source_id, target_id] of [
      [parent, child],
      [child, grandchild],
      [parent, alone],
    ] as const) {
      const edge = await client.createEdge({
        source_id,
        target_id,
        edge_type: "parent-of",
      });
      expect(edge.ok).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
    }

    // Trashed on its own first, so the parent's trash does not take it.
    expect((await client.deleteItem(alone)).ok).toBe(true);
    expect((await client.deleteItem(parent)).ok).toBe(true);
    for (const id of [child, grandchild]) {
      expect((await client.getItem(id)).status).toBe(404);
    }

    const restored = await client.restoreItem(parent);
    expect(restored.ok).toBe(true);
    for (const id of [parent, child, grandchild]) {
      const read = await client.getItem(id);
      expect(read.status, id).toBe(200);
      expect(read.data.item.state).toBe("active");
    }
    // The witness for the three above: a row the parent's trash did not
    // take stays where its own trash put it.
    expect((await client.getItem(alone)).status).toBe(404);
  });

  it("a transition out of the bin brings back what the trash took, as a restore does", async () => {
    const parent = await makeItem("t-parent");
    const child = await makeItem("t-child");
    const edge = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    expect((await client.deleteItem(parent)).ok).toBe(true);
    expect((await client.getItem(child)).status).toBe(404);

    expect((await client.transitionItem(parent, "active")).ok).toBe(true);
    expect((await client.getItem(child)).status).toBe(200);
  });

  it("restoring a row the trash above took brings back what that trash took beneath it, and not its siblings", async () => {
    const parent = await makeItem("m-parent");
    const middle = await makeItem("m-middle");
    const beneath = await makeItem("m-beneath");
    const sibling = await makeItem("m-sibling");
    for (const [source_id, target_id] of [
      [parent, middle],
      [middle, beneath],
      [parent, sibling],
    ] as const) {
      const edge = await client.createEdge({
        source_id,
        target_id,
        edge_type: "parent-of",
      });
      expect(edge.ok).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
    }
    expect((await client.deleteItem(parent)).ok).toBe(true);

    expect((await client.restoreItem(middle)).ok).toBe(true);
    expect((await client.getItem(beneath)).status).toBe(200);
    // The witness: what the same trash took from beside it stays.
    expect((await client.getItem(sibling)).status).toBe(404);
    expect((await client.getItem(parent)).status).toBe(404);
  });

  it("restores a parent whose trash took a child purged since", async () => {
    const parent = await makeItem("p-parent");
    const purged = await makeItem("p-purged");
    const kept = await makeItem("p-kept");
    for (const target_id of [purged, kept]) {
      const edge = await client.createEdge({
        source_id: parent,
        target_id,
        edge_type: "parent-of",
      });
      expect(edge.ok).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
    }
    expect((await client.deleteItem(parent)).ok).toBe(true);
    expect((await client.purgeItem(purged)).ok).toBe(true);

    const restored = await client.restoreItem(parent);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect((await client.getItem(kept)).status).toBe(200);
  });

  it("restoring a row brings back what lay beneath it after the parent whose trash took them is purged", async () => {
    const parent = await makeItem("g-parent");
    const middle = await makeItem("g-middle");
    const beneath = await makeItem("g-beneath");
    for (const [source_id, target_id] of [
      [parent, middle],
      [middle, beneath],
    ] as const) {
      const edge = await client.createEdge({
        source_id,
        target_id,
        edge_type: "parent-of",
      });
      expect(edge.ok).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
    }
    expect((await client.deleteItem(parent)).ok).toBe(true);
    expect((await client.purgeItem(parent)).ok).toBe(true);

    expect((await client.restoreItem(middle)).ok).toBe(true);
    expect(
      (await client.getItem(beneath)).status,
      "the row beneath stayed in the bin once the trash that took it lost its parent",
    ).toBe(200);
  });

  it("does not restore with a parent a child that left the bin and was trashed on its own since", async () => {
    const parent = await makeItem("o-parent");
    const child = await makeItem("o-child");
    const edge = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    expect((await client.deleteItem(parent)).ok).toBe(true);
    expect((await client.transitionItem(child, "active")).ok).toBe(true);
    expect((await client.deleteItem(child)).ok).toBe(true);

    expect((await client.restoreItem(parent)).ok).toBe(true);
    expect(
      (await client.getItem(child)).status,
      "a child trashed on its own came back with the parent whose trash had once taken it",
    ).toBe(404);
  });

  it("restoring a child alone brings back only that child", async () => {
    const parent = await makeItem("c-parent");
    const child = await makeItem("c-child");
    const sibling = await makeItem("c-sibling");
    for (const target_id of [child, sibling]) {
      const edge = await client.createEdge({
        source_id: parent,
        target_id,
        edge_type: "parent-of",
      });
      expect(edge.ok).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
    }
    expect((await client.deleteItem(parent)).ok).toBe(true);

    expect((await client.restoreItem(child)).ok).toBe(true);
    expect((await client.getItem(child)).status).toBe(200);
    expect((await client.getItem(parent)).status).toBe(404);
    expect((await client.getItem(sibling)).status).toBe(404);

    // The parent's restore still brings back the sibling its trash took,
    // and answers for the child already back rather than refusing.
    expect((await client.restoreItem(parent)).ok).toBe(true);
    expect((await client.getItem(sibling)).status).toBe(200);
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
