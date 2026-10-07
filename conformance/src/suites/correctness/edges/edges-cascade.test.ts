import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { ApiResponse, TestContext } from "../../../client/types.js";
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

  it("names every blocking edge in the cascade, not only the first it meets", async () => {
    const etId = `mock.deepblock.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const root = await makeItem("deep-root");
    const child = await makeItem("deep-child");
    const other = await makeItem("deep-other");
    const held = await client.createEdge({
      source_id: root,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(held.status, JSON.stringify(held.error)).toBe(201);
    trackEdge(ctx, held.data.edge.id);
    const blockers: string[] = [];
    for (const source of [root, child]) {
      const edge = await client.createEdge({
        source_id: source,
        target_id: other,
        edge_type: etId,
      });
      expect(edge.status, JSON.stringify(edge.error)).toBe(201);
      trackEdge(ctx, edge.data.edge.id);
      blockers.push(edge.data.edge.id);
    }

    // The witness: the child's own blocker refuses deleting the child.
    const childDelete = await client.deleteItem(child);
    expect(childDelete.status).toBe(400);

    const refused = await client.deleteItem(root);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("edge_constraint_violation");
    const named = (
      refused.error?.error.details?.blocking_edges as Array<{ id: string }>
    ).map((e) => e.id);
    expect(named.sort()).toEqual([...blockers].sort());
  });

  it("names every blocking edge in the cascade on a transition into the bin, as a delete does", async () => {
    const etId = `mock.deepblock-transition.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const root = await makeItem("deep-transition-root");
    const child = await makeItem("deep-transition-child");
    const other = await makeItem("deep-transition-other");
    const held = await client.createEdge({
      source_id: root,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(held.status, JSON.stringify(held.error)).toBe(201);
    trackEdge(ctx, held.data.edge.id);
    const blockers: string[] = [];
    for (const source of [root, child]) {
      const edge = await client.createEdge({
        source_id: source,
        target_id: other,
        edge_type: etId,
      });
      expect(edge.status, JSON.stringify(edge.error)).toBe(201);
      trackEdge(ctx, edge.data.edge.id);
      blockers.push(edge.data.edge.id);
    }
    const blockedBy = (refused: ApiResponse<unknown>): string[] =>
      (
        refused.error?.error.details?.blocking_edges as
          Array<{ id: string }> | undefined
      )?.map((e) => e.id) ?? [];

    // The witness: the child's own blocker is all a transition of the child meets.
    const childMove = await client.transitionItem(child, "trashed");
    expect(childMove.status).toBe(400);
    expect(blockedBy(childMove)).toEqual([blockers[1]]);

    const refused = await client.transitionItem(root, "trashed");
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("edge_constraint_violation");
    expect(blockedBy(refused).sort()).toEqual([...blockers].sort());

    // A delete of the same row names the same edges.
    const deleted = await client.deleteItem(root);
    expect(deleted.status).toBe(400);
    expect(blockedBy(deleted).sort()).toEqual(blockedBy(refused).sort());
    for (const id of [root, child]) {
      expect(
        (await client.getItem(id)).data.item.state,
        "a refused transition moved a row",
      ).toBe("active");
    }
  });

  it("purges an item held by a block edge, taking its edges on both ends", async () => {
    const etId = `mock.purgeblock.${ctx.runId}`;
    const register = async (cascade: "orphan" | "block") => {
      const reg = await client.registerEdgeType({
        id: etId,
        cardinality: "many-to-many",
        cascade_on_delete: cascade,
      });
      expect(reg.status, JSON.stringify(reg.error)).toBe(201);
    };

    // An item reaches the bin holding an edge of a blocking type only when
    // the type was registered otherwise at the time: a delete is refused
    // while a blocking edge stands. So the type is registered to orphan, the
    // item is trashed holding its edges, and the registration is replaced
    // by one that blocks.
    await register("orphan");
    trackEdgeType(ctx, etId);
    const held = await makeItem("pb-held");
    const upstream = await makeItem("pb-upstream");
    const downstream = await makeItem("pb-downstream");
    const unrelatedFrom = await makeItem("pb-other-from");
    const unrelatedTo = await makeItem("pb-other-to");
    const inbound = await client.createEdge({
      source_id: upstream,
      target_id: held,
      edge_type: etId,
    });
    const outbound = await client.createEdge({
      source_id: held,
      target_id: downstream,
      edge_type: etId,
    });
    const unrelated = await client.createEdge({
      source_id: unrelatedFrom,
      target_id: unrelatedTo,
      edge_type: etId,
    });
    for (const e of [inbound, outbound, unrelated]) {
      expect(e.status, JSON.stringify(e.error)).toBe(201);
      trackEdge(ctx, e.data.edge.id);
    }
    expect((await client.deleteItem(held)).ok).toBe(true);

    expect((await client.deleteEdgeType(etId, true)).ok).toBe(true);
    await register("block");

    // The witness: this type blocks, so a live item holding one of its
    // edges cannot be deleted.
    const blocked = await client.deleteItem(unrelatedFrom);
    expect(blocked.status).toBe(400);
    expect(blocked.error?.error.code).toBe("edge_constraint_violation");

    // Both edges of the trashed item are still stored, held by the type.
    expect((await client.getEdge(inbound.data.edge.id)).status).toBe(200);
    expect((await client.getEdge(outbound.data.edge.id)).status).toBe(200);

    const purged = await client.purgeItem(held);
    expect(purged.status, JSON.stringify(purged.error)).toBe(200);

    for (const gone of [inbound, outbound]) {
      const read = await client.getEdge(gone.data.edge.id);
      expect(read.status).toBe(404);
      expect(read.error?.error.code).toBe("edge_not_found");
    }
    const listed = await client.listEdges({ edge_type: etId, limit: 500 });
    expect(listed.data.data.map((e) => e.id)).toEqual([unrelated.data.edge.id]);
    expect((await client.listItemEdges(upstream)).data.data).toEqual([]);
    expect((await client.listItemBackrefs(downstream)).data.data).toEqual([]);
    expect((await client.getEdge(unrelated.data.edge.id)).status).toBe(200);
  });

  it("a transition into the bin takes what a delete takes, and a restore brings it back", async () => {
    const parent = await makeItem("t-parent");
    const child = await makeItem("t-child");
    const edge = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const moved = await client.transitionItem(parent, "trashed");
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.item.state).toBe("trashed");
    expect((await client.getItem(child)).status).toBe(404);

    // Recorded as taken with the parent, so leaving the bin brings it back.
    const back = await client.transitionItem(parent, "active");
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    const restored = await client.getItem(child);
    expect(restored.status).toBe(200);
    expect(restored.data.item.state).toBe("active");
  });

  it("a block edge refuses a transition into the bin as it refuses a delete", async () => {
    const etId = `mock.block-transition.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const source = await makeItem("tb-src");
    const target = await makeItem("tb-tgt");
    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: etId,
    });
    expect(edge.ok).toBe(true);
    const edgeId = edge.data.edge.id;
    trackEdge(ctx, edgeId);

    const moved = await client.transitionItem(source, "trashed");
    expect(moved.status).toBe(400);
    expect(moved.error?.error.code).toBe("edge_constraint_violation");
    expect(
      (moved.error?.error.details?.blocking_edges as Array<{ id: string }>).map(
        (e) => e.id,
      ),
    ).toEqual([edgeId]);
    expect((await client.getItem(source)).data.item.state).toBe("active");

    // The bulk-action transition is held by the same edge, per row.
    const tag = `block-bulk-${ctx.runId}`;
    expect((await client.updateMetadata(source, { tags: [tag] })).ok).toBe(
      true,
    );
    const queued = await client.bulkAction({
      action: "transition",
      state: "trashed",
      filter: { tags: [tag] },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await client.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.result?.succeeded).toBe(0);
    expect(job.result?.errors).toEqual([
      expect.objectContaining({
        id: source,
        code: "edge_constraint_violation",
      }),
    ]);
    expect((await client.getItem(source)).data.item.state).toBe("active");
  });

  it("takes what a cascade reaches on a bulk transition into the bin, and brings it back on a restore", async () => {
    const tag = `bulk-trash-${ctx.runId}`;
    const parent = await makeItem("bt-parent");
    const child = await makeItem("bt-child");
    const edge = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    // Only the parent matches the filter, so the child is taken by the edge.
    expect((await client.updateMetadata(parent, { tags: [tag] })).ok).toBe(
      true,
    );

    const queued = await client.bulkAction({
      action: "transition",
      state: "trashed",
      filter: { tags: [tag] },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await client.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.result?.succeeded).toBe(1);
    expect(job.result?.errors ?? []).toEqual([]);
    expect((await client.getItem(parent)).status).toBe(404);
    expect((await client.getItem(child)).status).toBe(404);
    const trashed = await client.listItems({
      source: ctx.source,
      state: "trashed",
      limit: 100,
    });
    expect(trashed.data.data.map((i) => i.id)).toEqual(
      expect.arrayContaining([parent, child]),
    );

    const restored = await client.restoreItem(parent);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const back = await client.getItem(child);
    expect(back.status).toBe(200);
    expect(back.data.item.state).toBe("active");
  });

  it("refuses a transition into the bin held by a block edge into the row, or on a row the cascade reaches", async () => {
    const etId = `mock.block-reach.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const edgeBetween = async (
      source_id: string,
      target_id: string,
      edge_type: string,
    ): Promise<string> => {
      const made = await client.createEdge({
        source_id,
        target_id,
        edge_type,
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      trackEdge(ctx, made.data.edge.id);
      return made.data.edge.id;
    };
    const blockedBy = (
      moved: Awaited<ReturnType<typeof client.transitionItem>>,
    ): string[] =>
      (
        moved.error?.error.details?.blocking_edges as
          Array<{ id: string }> | undefined
      )?.map((e) => e.id) ?? [];

    // A block edge pointing into the row named.
    const named = await makeItem("br-named");
    const pointing = await makeItem("br-pointing");
    const into = await edgeBetween(pointing, named, etId);
    const refusedInto = await client.transitionItem(named, "trashed");
    expect(refusedInto.status).toBe(400);
    expect(refusedInto.error?.error.code).toBe("edge_constraint_violation");
    expect(blockedBy(refusedInto)).toEqual([into]);
    expect((await client.getItem(named)).data.item.state).toBe("active");

    // A block edge on a child the cascade would take.
    const parent = await makeItem("br-parent");
    const child = await makeItem("br-child");
    const held = await makeItem("br-held");
    await edgeBetween(parent, child, "parent-of");
    const onChild = await edgeBetween(child, held, etId);
    const refusedChild = await client.transitionItem(parent, "trashed");
    expect(refusedChild.status).toBe(400);
    expect(refusedChild.error?.error.code).toBe("edge_constraint_violation");
    expect(blockedBy(refusedChild)).toEqual([onChild]);
    for (const id of [parent, child]) {
      expect(
        (await client.getItem(id)).data.item.state,
        "a refused transition moved a row",
      ).toBe("active");
    }

    // The witness: with each blocking edge gone the same moves are taken.
    expect((await client.deleteEdge(into)).ok).toBe(true);
    expect((await client.deleteEdge(onChild)).ok).toBe(true);
    expect((await client.transitionItem(named, "trashed")).status).toBe(200);
    expect((await client.transitionItem(parent, "trashed")).status).toBe(200);
    expect((await client.getItem(child)).status).toBe(404);
  });
});
