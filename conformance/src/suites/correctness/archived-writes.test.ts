import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
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
  ({ ctx, client } = await createTestContext("correctness", "archived-writes"));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Held = "active" | "archived";
const HELD: Held[] = ["active", "archived"];

async function note(
  state: Held = "active",
  extra: { tags?: string[]; body?: string } = {},
): Promise<MarfaItem> {
  const made = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { body: extra.body ?? `archived-writes-${ctx.runId}` },
      ...(extra.tags === undefined ? {} : { tags: extra.tags }),
    }),
  );
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  if (state === "archived") {
    const moved = await client.transitionItem(made.data.item.id, "archived");
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    return moved.data.item;
  }
  return made.data.item;
}

async function read(id: string) {
  const got = await client.getItem(id);
  expect(got.status, JSON.stringify(got.error)).toBe(200);
  return got.data;
}

async function stateOf(id: string): Promise<string> {
  return (await read(id)).item.state;
}

async function edgeBetween(
  from_id: string,
  to_id: string,
  edge_type = "parent-of",
  properties?: Record<string, unknown>,
) {
  const made = await client.createEdge({
    from_id,
    to_id,
    edge_type,
    ...(properties === undefined ? {} : { properties }),
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackEdge(ctx, made.data.edge.id);
  return made.data.edge;
}

describe("an edit of an archived item", () => {
  it("takes PATCH /items/{id} as it takes it on an active item, and leaves the state", async () => {
    for (const held of HELD) {
      const item = await note(held);
      const edited = await client.updateItem(item.id, {
        properties: { body: `edited-${held}` },
        version: item.version,
      });
      expect(edited.status, `${held}: ${JSON.stringify(edited.error)}`).toBe(
        200,
      );
      expect(edited.data.item.version).toBe(item.version + 1);
      const back = await read(item.id);
      expect(back.item.properties.body).toBe(`edited-${held}`);
      expect(back.item.state).toBe(held);
    }
  });

  it("takes a move to the bin from DELETE /items/{id}, as an active item does", async () => {
    for (const held of HELD) {
      const item = await note(held);
      const deleted = await client.deleteItem(item.id);
      expect(deleted.status, `${held}: ${JSON.stringify(deleted.error)}`).toBe(
        200,
      );
      expect((await client.getItem(item.id)).status).toBe(404);
      const binned = await client.listItems({
        source: ctx.source,
        state: "trashed",
        limit: 500,
      });
      expect(binned.data.data.map((row) => row.id)).toContain(item.id);
    }
  });
});

describe("the tags of an archived item", () => {
  it("take POST, PUT and DELETE on /items/{id}/tags as they do on an active item, and leave the state", async () => {
    for (const held of HELD) {
      const item = await note(held, { tags: ["kept"] });

      const added = await client.addTags(item.id, ["added"]);
      expect(added.status, `${held}: ${JSON.stringify(added.error)}`).toBe(200);
      expect([...added.data.tags].sort()).toEqual(["added", "kept"]);
      expect([...(await read(item.id)).metadata.tags].sort()).toEqual([
        "added",
        "kept",
      ]);

      const replaced = await client.replaceTags(item.id, {
        tags: ["replaced"],
      });
      expect(
        replaced.status,
        `${held}: ${JSON.stringify(replaced.error)}`,
      ).toBe(200);
      expect((await read(item.id)).metadata.tags).toEqual(["replaced"]);

      const removed = await client.removeTag(item.id, "replaced");
      expect(removed.status, `${held}: ${JSON.stringify(removed.error)}`).toBe(
        200,
      );
      const back = await read(item.id);
      expect(back.metadata.tags).toEqual([]);
      expect(back.item.state).toBe(held);
    }
  });
});

describe("the extensions of an archived item", () => {
  it("take PUT and DELETE on /items/{id}/extensions/{namespace} as they do on an active item, and leave the state", async () => {
    for (const held of HELD) {
      const item = await note(held);
      const put = await client.setItemExtension(item.id, "app.archived", {
        v: held,
      });
      expect(put.status, `${held}: ${JSON.stringify(put.error)}`).toBe(200);
      const stored = await client.getItemExtension(item.id, "app.archived");
      expect(stored.status).toBe(200);
      expect(stored.data.document).toEqual({ v: held });

      const removed = await client.deleteItemExtension(item.id, "app.archived");
      expect(removed.status, `${held}: ${JSON.stringify(removed.error)}`).toBe(
        200,
      );
      const gone = await client.getItemExtension(item.id, "app.archived");
      expect(gone.data.document, held).toBeNull();
      expect(await stateOf(item.id)).toBe(held);
    }
  });
});

describe("the edges of an archived item", () => {
  it("take POST /edges, PATCH /edges/{id} and DELETE /edges/{id} with the archived item at either end, as they do with an active item", async () => {
    for (const held of HELD) {
      const mine = await note(held);
      const other = await note("active");

      const outbound = await edgeBetween(mine.id, other.id);
      const inbound = await edgeBetween(other.id, mine.id, "references", {
        since: "spring",
      });
      const listed = await client.listItemEdges(mine.id);
      expect(listed.data.data.map((edge) => edge.id)).toEqual([outbound.id]);
      expect((await client.getEdge(inbound.id)).data.edge.to_id).toBe(mine.id);

      const patched = await client.updateEdge(inbound.id, {
        properties: { note: held },
        version: inbound.version,
      });
      expect(patched.status, `${held}: ${JSON.stringify(patched.error)}`).toBe(
        200,
      );
      expect(patched.data.edge.properties).toEqual({
        since: "spring",
        note: held,
      });

      for (const id of [outbound.id, inbound.id]) {
        const deleted = await client.deleteEdge(id);
        expect(
          deleted.status,
          `${held}: ${JSON.stringify(deleted.error)}`,
        ).toBe(200);
        expect((await client.getEdge(id)).status).toBe(404);
      }
      expect(await stateOf(mine.id)).toBe(held);
      expect(await stateOf(other.id)).toBe("active");
    }
  });

  it("take an entry of POST /edges/bulk with the archived item at either end, as they do with an active item", async () => {
    for (const held of HELD) {
      const mine = await note(held);
      const other = await note("active");
      const bulk = await client.bulkEdges({
        edges: [
          { from_id: mine.id, to_id: other.id, edge_type: "parent-of" },
          { from_id: other.id, to_id: mine.id, edge_type: "references" },
        ],
      });
      expect(bulk.status, `${held}: ${JSON.stringify(bulk.error)}`).toBe(200);
      expect(bulk.data.counts, held).toMatchObject({
        created: 2,
        errored: 0,
        skipped: 0,
      });
      for (const result of bulk.data.results) {
        expect(result.outcome).toBe("created");
        trackEdge(ctx, result.id ?? "");
      }
      expect(await stateOf(mine.id)).toBe(held);
    }
  });

  it("take the edges of POST /items and of PATCH /items/{id}, with the archived item the one the edge names or the one that is written, as they do with an active item", async () => {
    for (const held of HELD) {
      const target = await note(held);
      const created = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { body: `inline-${held}` },
          edges: { references: [target.id] },
        }),
      );
      expect(created.status, `${held}: ${JSON.stringify(created.error)}`).toBe(
        201,
      );
      trackItem(ctx, created.data.item.id);
      const first = await client.listItemEdges(created.data.item.id, {
        edge_type: "references",
      });
      expect(first.data.data.map((edge) => edge.to_id)).toEqual([target.id]);

      const writer = await note(held);
      const patched = await client.updateItem(writer.id, {
        edges: { references: [target.id] },
        version: writer.version,
      });
      expect(patched.status, `${held}: ${JSON.stringify(patched.error)}`).toBe(
        200,
      );
      const second = await client.listItemEdges(writer.id, {
        edge_type: "references",
      });
      expect(second.data.data.map((edge) => edge.to_id)).toEqual([target.id]);
      expect(await stateOf(writer.id)).toBe(held);
      expect(await stateOf(target.id)).toBe(held);
    }
  });
});

describe("archiving an item", () => {
  it("changes the state of no other item, whatever edges the item holds", async () => {
    const custom = `mock.archive-cascade.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      label: "Test edge type",
      id: custom,
      cardinality: "many-to-many",
      cascade_on_delete: "cascade",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    trackEdgeType(ctx, custom);

    const grandparent = await note();
    const host = await note();
    const child = await note();
    const grandchild = await note();
    const sibling = await note();
    const bound = await note();
    const part = await note();
    await edgeBetween(grandparent.id, host.id);
    await edgeBetween(host.id, child.id);
    await edgeBetween(child.id, grandchild.id);
    await edgeBetween(grandparent.id, sibling.id);
    await edgeBetween(host.id, bound.id, custom);
    await edgeBetween(part.id, host.id, "comments-on");

    const moved = await client.transitionItem(host.id, "archived");
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.item.state).toBe("archived");

    for (const other of [
      grandparent,
      child,
      grandchild,
      sibling,
      bound,
      part,
    ]) {
      expect(await stateOf(other.id), other.id).toBe("active");
    }

    const second = await note();
    const secondChild = await note();
    await edgeBetween(second.id, secondChild.id);
    expect((await client.deleteItem(second.id)).status).toBe(200);
    expect((await client.getItem(secondChild.id)).status).toBe(404);
  });

  it("changes the state of no other item on a bulk transition to archived", async () => {
    const tag = `archive-bulk-${ctx.runId}`;
    const host = await note("active", { tags: [tag] });
    const child = await note();
    await edgeBetween(host.id, child.id);

    const queued = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await client.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.result?.succeeded).toBe(1);
    expect(await stateOf(host.id)).toBe("archived");
    expect(await stateOf(child.id)).toBe("active");
  });
});
