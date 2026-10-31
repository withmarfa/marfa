// A part is the source of an edge whose type deletes `with-hosts`
// (`attached-to`, `comments-on` or a registered type declaring it); its hosts
// are that edge's targets. Each absence here sits beside the same path
// producing the thing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { MarfaItem, TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackView,
  cleanup,
} from "../../../utils/setup.js";
import { createNote } from "../../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "edges-parts"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function note(tag: string, body = `parts-${tag}`): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body }, tags: [tag] }),
  );
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function edge(
  source_id: string,
  target_id: string,
  edge_type: string,
): Promise<string> {
  const r = await client.createEdge({ source_id, target_id, edge_type });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge.id;
}

async function stateOf(id: string): Promise<string | undefined> {
  for (const state of ["active", "archived", "trashed"]) {
    const r = await client.listItems({
      source: ctx.source,
      state,
      limit: 500,
    });
    expect(r.status).toBe(200);
    if (r.data.data.some((item) => item.id === id)) return state;
  }
  return undefined;
}

async function trashed(tag: string): Promise<Map<string, MarfaItem>> {
  const r = await client.listItems({ tags: [tag], state: "trashed", limit: 100 });
  expect(r.status).toBe(200);
  return new Map(r.data.data.map((item) => [item.id, item]));
}

async function del(id: string): Promise<void> {
  const r = await client.deleteItem(id);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
}

async function restore(id: string): Promise<void> {
  const r = await client.restoreItem(id);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
}

async function purge(id: string): Promise<void> {
  const r = await client.purgeItem(id);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
}

describe("a part goes to the bin with its hosts", () => {
  it("stays out while one host is out, goes with the last, and comes back with any", async () => {
    const tag = `parts-two-${ctx.runId}`;
    const part = await note(tag);
    const first = await note(tag);
    const second = await note(tag);
    await edge(part, first, "attached-to");
    await edge(part, second, "attached-to");

    await del(first);
    expect(await stateOf(part)).toBe("active");

    await del(second);
    expect(await stateOf(part)).toBe("trashed");
    const marked = (await trashed(tag)).get(part);
    expect(marked?.trashed_by_cascade).toBe(true);
    expect(marked?.trashed_with).toBe(second);

    await restore(first);
    expect(await stateOf(part)).toBe("active");
    expect(await stateOf(second)).toBe("trashed");
  });

  it("takes a reply with the comment it answers, at every depth, and the part's own children", async () => {
    const tag = `parts-replies-${ctx.runId}`;
    const host = await note(tag);
    const comment = await note(tag);
    const reply = await note(tag);
    const replyToReply = await note(tag);
    const child = await note(tag);
    await edge(comment, host, "comments-on");
    await edge(reply, comment, "comments-on");
    await edge(replyToReply, reply, "comments-on");
    await edge(comment, child, "parent-of");

    await del(host);
    const binned = await trashed(tag);
    for (const id of [comment, reply, replyToReply, child]) {
      expect(binned.has(id), id).toBe(true);
      expect(binned.get(id)?.trashed_with).toBe(host);
    }

    await restore(host);
    for (const id of [host, comment, reply, replyToReply, child]) {
      expect(await stateOf(id), id).toBe("active");
    }
  });

  it("takes the parts a transition into the bin takes, and brings them back on a transition out", async () => {
    const tag = `parts-transition-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    await edge(part, host, "comments-on");

    expect((await client.transitionItem(host, "trashed")).status).toBe(200);
    expect(await stateOf(part)).toBe("trashed");
    expect((await client.transitionItem(host, "active")).status).toBe(200);
    expect(await stateOf(part)).toBe("active");
  });

  it("brings back with a comment restored on its own the replies its host's trash took", async () => {
    const tag = `parts-reply-alone-${ctx.runId}`;
    const host = await note(tag);
    const comment = await note(tag);
    const reply = await note(tag);
    await edge(comment, host, "comments-on");
    await edge(reply, comment, "comments-on");

    await del(host);
    await restore(comment);
    expect(await stateOf(reply)).toBe("active");
    expect(await stateOf(host)).toBe("trashed");
  });

  it("does not bring back with its host a part trashed on its own", async () => {
    const tag = `parts-alone-${ctx.runId}`;
    const host = await note(tag);
    const alone = await note(tag);
    const taken = await note(tag);
    await edge(alone, host, "attached-to");
    await edge(taken, host, "attached-to");

    await del(alone);
    await del(host);
    await restore(host);
    // The witness: the part the host's trash took comes back.
    expect(await stateOf(taken)).toBe("active");
    expect(await stateOf(alone)).toBe("trashed");
  });

  it("takes a part on a bulk transition into the bin and brings it back on one out", async () => {
    const tag = `parts-bulk-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(`${tag}-part`);
    await edge(part, host, "attached-to");

    for (const [from, state] of [
      ["active", "trashed"],
      ["trashed", "active"],
    ] as const) {
      const started = await client.bulkAction({
        action: "transition",
        filter: { tags: [tag], source: ctx.source, state: from },
        state,
      });
      expect(started.status, JSON.stringify(started.error)).toBe(202);
      const job = await client.pollBulkActionToTerminal(
        (started.data as { id: string }).id,
      );
      expect(job.status).toBe("completed");
      expect(await stateOf(part), state).toBe(state);
    }
  });

  it("names the parts a trash would take in its preview", async () => {
    const tag = `parts-preview-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    const shared = await note(tag);
    const elsewhere = await note(tag);
    await edge(part, host, "attached-to");
    await edge(shared, host, "attached-to");
    await edge(shared, elsewhere, "attached-to");

    const preview = await client.previewItemTrash([host]);
    expect(preview.status).toBe(200);
    // A part with another host out of the bin is not taken.
    expect(preview.data.items[0]?.takes.map((t) => t.id)).toEqual([part]);
    expect(preview.data.count).toBe(2);
  });

  it("bins nothing when an edge is removed, even the last to a host out of the bin", async () => {
    const tag = `parts-unlink-${ctx.runId}`;
    const part = await note(tag);
    const binnedHost = await note(tag);
    const liveHost = await note(tag);
    await edge(part, binnedHost, "attached-to");
    const live = await edge(part, liveHost, "attached-to");
    await del(binnedHost);
    expect(await stateOf(part)).toBe("active");

    expect((await client.deleteEdge(live)).status).toBe(200);
    expect(await stateOf(part)).toBe("active");
  });

  it("changes nothing when a host is archived", async () => {
    const tag = `parts-archive-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    await edge(part, host, "comments-on");

    expect((await client.transitionItem(host, "archived")).status).toBe(200);
    expect(await stateOf(part)).toBe("active");
    const listed = await client.listItems({
      tags: [tag],
      filter: "part eq true",
    });
    expect(listed.data.data.map((i) => i.id)).toEqual([part]);
  });

  it("treats a registered edge type that declares with-hosts as a shipped one", async () => {
    const tag = `parts-registered-${ctx.runId}`;
    const id = `mock.part-of.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id,
      label: "Part of",
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "with-hosts",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    trackEdgeType(ctx, id);
    expect(registered.data.edge_type.cascade_on_delete).toBe("with-hosts");

    const host = await note(tag);
    const part = await note(tag);
    await edge(part, host, id);
    await del(host);
    expect(await stateOf(part)).toBe("trashed");
    await restore(host);
    expect(await stateOf(part)).toBe("active");
  });
});

describe("a late part", () => {
  it("is accepted to a host in the bin and goes to the bin in the same write", async () => {
    const tag = `parts-late-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    await del(host);

    // The witness: an edge of another type to the same host is refused.
    const about = await client.createEdge({
      source_id: part,
      target_id: host,
      edge_type: "about",
    });
    expect(about.status).toBe(404);

    await edge(part, host, "attached-to");
    expect(await stateOf(part)).toBe("trashed");
    expect((await trashed(tag)).get(part)?.trashed_with).toBe(host);

    await restore(host);
    expect(await stateOf(part)).toBe("active");
  });

  it("stays out of the bin while it has a host out of the bin", async () => {
    const tag = `parts-late-live-${ctx.runId}`;
    const binned = await note(tag);
    const live = await note(tag);
    const part = await note(tag);
    await edge(part, live, "attached-to");
    await del(binned);

    await edge(part, binned, "attached-to");
    expect(await stateOf(part)).toBe("active");
  });

  it("is refused from a source in the bin", async () => {
    const tag = `parts-late-source-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    await del(part);
    const r = await client.createEdge({
      source_id: part,
      target_id: host,
      edge_type: "attached-to",
    });
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("item_not_found");
  });

  it("arriving later, as an offline write syncs, behaves the same at every door", async () => {
    const tag = `parts-late-doors-${ctx.runId}`;
    const host = await note(tag);
    await del(host);

    // A create carrying its edges.
    const created = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { body: "late inline" },
        tags: [tag],
        edges: { "comments-on": [host] },
      }),
    );
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    expect(await stateOf(created.data.item.id)).toBe("trashed");

    // An update carrying its edges.
    const updated = await note(tag);
    const patch = await client.updateItem(updated, {
      edges: { "attached-to": [host] },
      version: 1,
    });
    expect(patch.status, JSON.stringify(patch.error)).toBe(200);
    expect(await stateOf(updated)).toBe("trashed");

    // The bulk door.
    const bulk = await note(tag);
    const sent = await client.bulkEdges({
      edges: [{ source_id: bulk, target_id: host, edge_type: "attached-to" }],
    });
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect(sent.data.results[0]?.outcome).toBe("created");
    expect(await stateOf(bulk)).toBe("trashed");

    // A move of an edge onto the host: the many-to-one type, whose source
    // end holds one edge and so can move its target.
    const moved = await note(tag);
    const elsewhere = await note(tag);
    const id = await edge(moved, elsewhere, "comments-on");
    const read = await client.getEdge(id);
    const move = await client.updateEdge(id, {
      target_id: host,
      version: read.data.edge.version,
    });
    expect(move.status, JSON.stringify(move.error)).toBe(200);
    expect(await stateOf(moved)).toBe("trashed");

    await restore(host);
    for (const part of [created.data.item.id, updated, bulk, moved]) {
      expect(await stateOf(part), part).toBe("active");
    }
  });
});

describe("a purge of a host", () => {
  it("purges a part it leaves with no host, at every depth", async () => {
    const tag = `parts-purge-${ctx.runId}`;
    const host = await note(tag);
    const comment = await note(tag);
    const reply = await note(tag);
    await edge(comment, host, "comments-on");
    await edge(reply, comment, "comments-on");
    await del(host);

    await purge(host);
    for (const id of [comment, reply]) {
      expect((await client.purgeItem(id)).status, id).toBe(404);
      expect(await stateOf(id), id).toBeUndefined();
    }
  });

  it("keeps a part whose other host is in the bin, which a restore of that host brings back", async () => {
    const tag = `parts-purge-one-${ctx.runId}`;
    const part = await note(tag);
    const first = await note(tag);
    const second = await note(tag);
    await edge(part, first, "attached-to");
    await edge(part, second, "attached-to");
    await del(first);
    await del(second);

    await purge(first);
    expect(await stateOf(part)).toBe("trashed");
    await restore(second);
    expect(await stateOf(part)).toBe("active");
  });

  it("leaves in the bin a part trashed on its own", async () => {
    const tag = `parts-purge-alone-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    await edge(part, host, "attached-to");
    await del(part);
    await del(host);

    await purge(host);
    expect(await stateOf(part)).toBe("trashed");
  });

  it("counts a part a bulk purge took with its host, and is not refused for it", async () => {
    const tag = `parts-bulk-purge-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    await edge(part, host, "attached-to");
    await del(host);

    const started = await client.bulkAction({
      action: "purge",
      filter: { tags: [tag], source: ctx.source, state: "trashed" },
      confirm: "PURGE",
    });
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    const job = await client.pollBulkActionToTerminal(
      (started.data as { id: string }).id,
    );
    expect(job.status).toBe("completed");
    expect(job.errored).toBe(0);
    for (const id of [host, part]) {
      expect(await stateOf(id), id).toBeUndefined();
    }
  });
});

describe("a cycle of parts", () => {
  it("is refused across attached-to and comments-on", async () => {
    const tag = `parts-cycle-${ctx.runId}`;
    const a = await note(tag);
    const b = await note(tag);
    const c = await note(tag);
    await edge(a, b, "comments-on");
    await edge(b, c, "attached-to");

    const refused = await client.createEdge({
      source_id: c,
      target_id: a,
      edge_type: "attached-to",
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("edge_constraint_violation");
    expect(refused.error?.error.details).toEqual({
      edge_type: "attached-to",
      source_id: c,
      target_id: a,
      constraint: "cycle",
    });

    // The witness: the same edge to an item outside the chain lands.
    await edge(c, await note(tag), "attached-to");
  });
});

describe("the part filter term", () => {
  it("selects parts with a host out of the bin on GET /items, stats and a saved view", async () => {
    const tag = `parts-filter-${ctx.runId}`;
    const host = await note(tag);
    const part = await note(tag);
    const orphaned = await note(tag);
    const binnedHost = await note(tag);
    await edge(part, host, "attached-to");
    await edge(orphaned, binnedHost, "comments-on");
    await del(binnedHost);
    // A part restored on its own while its only host is in the bin.
    await restore(orphaned);

    const ids = async (filter: string) => {
      const r = await client.listItems({ tags: [tag], filter, limit: 100 });
      expect(r.status, JSON.stringify(r.error)).toBe(200);
      return r.data.data.map((item) => item.id).sort();
    };
    expect(await ids("part eq true")).toEqual([part]);
    const rest = [host, orphaned].sort();
    expect(await ids("part eq false")).toEqual(rest);
    expect(await ids("part neq true")).toEqual(rest);

    const stats = await client.rawRequest<Record<string, number>>(
      `/items/stats?tags=${tag}&filter=${encodeURIComponent("part eq true")}`,
    );
    expect(stats.status).toBe(200);
    expect(stats.data).toEqual({ active: 1 });

    const view = await client.createView({
      title: "Parts",
      query: { filter: `part eq false AND tags contains "${tag}"` },
    });
    expect(view.status, JSON.stringify(view.error)).toBe(201);
    trackView(ctx, view.data.item.id);
    const listed = await client.listViewItems(view.data.item.id);
    expect(listed.status).toBe(200);
    expect(listed.data.data.map((item) => item.id).sort()).toEqual(rest);
  });

  it("refuses any other operator or value with a validation error", async () => {
    for (const filter of [
      "part gt true",
      'part eq "yes"',
      "part eq null",
      "part contains true",
    ]) {
      const r = await client.listItems({ filter });
      expect(r.status, filter).toBe(400);
      expect(r.error?.error.code, filter).toBe("validation_error");
    }
  });
});
