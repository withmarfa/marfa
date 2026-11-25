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

type End = "from" | "to";
const ENDS: End[] = ["from", "to"];

/** The archived (or active) item `mine` and `other`, ordered as the edge's ends. */
function ordered(end: End, mine: string, other: string) {
  return end === "from"
    ? { from_id: mine, to_id: other }
    : { from_id: other, to_id: mine };
}

async function stored(id: string) {
  const got = await client.getEdge(id);
  expect(got.status, JSON.stringify(got.error)).toBe(200);
  return got.data.edge;
}

describe("the edges of an archived item", () => {
  it("take POST /edges, PATCH /edges/{id} and DELETE /edges/{id} with the archived item at either end, as they do with an active item", async () => {
    // A one-to-one type, whose edge can move an end, since the end that stays holds only it.
    const movable = `mock.archived-move.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      label: "Test edge type",
      id: movable,
      cardinality: "one-to-one",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    trackEdgeType(ctx, movable);

    for (const held of HELD) {
      for (const end of ENDS) {
        const label = `${held} at the ${end} end`;
        const mine = await note(held);
        const other = await note("active");
        const third = await note("active");

        const made = await edgeBetween(
          ordered(end, mine.id, other.id).from_id,
          ordered(end, mine.id, other.id).to_id,
          "references",
          { since: "spring" },
        );
        expect(await stored(made.id), label).toMatchObject(
          ordered(end, mine.id, other.id),
        );

        const patched = await client.updateEdge(made.id, {
          properties: { note: held },
          version: made.version,
        });
        expect(
          patched.status,
          `${label}: ${JSON.stringify(patched.error)}`,
        ).toBe(200);
        expect((await stored(made.id)).properties, label).toEqual({
          since: "spring",
          note: held,
        });

        // An endpoint moved onto the item, then off it, on an edge between two others.
        const loose = await edgeBetween(other.id, third.id, movable);
        const onto = await client.updateEdge(loose.id, {
          ...(end === "from" ? { from_id: mine.id } : { to_id: mine.id }),
          version: loose.version,
        });
        expect(onto.status, `${label}: ${JSON.stringify(onto.error)}`).toBe(
          200,
        );
        expect(await stored(loose.id), label).toMatchObject(
          end === "from"
            ? { from_id: mine.id, to_id: third.id }
            : { from_id: other.id, to_id: mine.id },
        );
        const off = await client.updateEdge(loose.id, {
          ...(end === "from" ? { from_id: other.id } : { to_id: third.id }),
          version: onto.data.edge.version,
        });
        expect(off.status, `${label}: ${JSON.stringify(off.error)}`).toBe(200);
        expect(await stored(loose.id), label).toMatchObject({
          from_id: other.id,
          to_id: third.id,
        });

        for (const id of [made.id, loose.id]) {
          const deleted = await client.deleteEdge(id);
          expect(
            deleted.status,
            `${label}: ${JSON.stringify(deleted.error)}`,
          ).toBe(200);
          expect((await client.getEdge(id)).status, label).toBe(404);
        }
        expect(await stateOf(mine.id), label).toBe(held);
        expect(await stateOf(other.id), label).toBe("active");
      }
    }
  });

  it("take an entry of POST /edges/bulk that creates or changes an edge with the archived item at either end, as they do with an active item", async () => {
    for (const held of HELD) {
      for (const end of ENDS) {
        const label = `${held} at the ${end} end`;
        const mine = await note(held);
        const other = await note("active");
        const fourth = await note("active");
        const held_edge = await edgeBetween(other.id, fourth.id, "references", {
          since: "spring",
        });

        const created = await client.bulkEdges({
          edges: [
            { ...ordered(end, mine.id, other.id), edge_type: "references" },
          ],
        });
        expect(
          created.status,
          `${label}: ${JSON.stringify(created.error)}`,
        ).toBe(200);
        expect(created.data.counts, label).toMatchObject({
          created: 1,
          errored: 0,
          skipped: 0,
        });
        const createdId = created.data.results[0]!.id ?? "";
        trackEdge(ctx, createdId);
        expect(await stored(createdId), label).toMatchObject(
          ordered(end, mine.id, other.id),
        );

        const changed = await client.bulkEdges({
          edges: [
            {
              id: createdId,
              ...ordered(end, mine.id, other.id),
              edge_type: "references",
              properties: { note: held },
              version: (await stored(createdId)).version,
            },
            {
              id: held_edge.id,
              from_id: other.id,
              to_id: fourth.id,
              edge_type: "references",
              properties: { since: "autumn" },
              version: held_edge.version,
            },
          ],
        });
        expect(
          changed.status,
          `${label}: ${JSON.stringify(changed.error)}`,
        ).toBe(200);
        expect(changed.data.counts, label).toMatchObject({
          updated: 2,
          errored: 0,
          skipped: 0,
        });
        expect((await stored(createdId)).properties, label).toEqual({
          note: held,
        });
        expect((await stored(held_edge.id)).properties, label).toEqual({
          since: "autumn",
        });
        expect(await stateOf(mine.id), label).toBe(held);
      }
    }
  });

  it("take the edges of POST /items and of PATCH /items/{id}, with the archived item the one that is written or the one the edge names, as they do with an active item", async () => {
    for (const written of HELD) {
      for (const named of HELD) {
        const label = `written ${written}, named ${named}`;
        const target = await note(named);

        const created = await client.createItem(
          createNote({
            source: ctx.source,
            properties: { body: `inline-${label}` },
            ...(written === "archived" ? { state: "archived" } : {}),
            edges: { references: [target.id] },
          }),
        );
        expect(
          created.status,
          `${label}: ${JSON.stringify(created.error)}`,
        ).toBe(201);
        trackItem(ctx, created.data.item.id);
        expect(await stateOf(created.data.item.id), label).toBe(written);
        const first = await client.listItemEdges(created.data.item.id, {
          edge_type: "references",
        });
        expect(
          first.data.data.map((edge) => edge.to_id),
          label,
        ).toEqual([target.id]);

        const writer = await note(written);
        const patched = await client.updateItem(writer.id, {
          edges: { references: [target.id] },
          version: writer.version,
        });
        expect(
          patched.status,
          `${label}: ${JSON.stringify(patched.error)}`,
        ).toBe(200);
        const second = await client.listItemEdges(writer.id, {
          edge_type: "references",
        });
        expect(
          second.data.data.map((edge) => edge.to_id),
          label,
        ).toEqual([target.id]);
        expect(await stateOf(writer.id), label).toBe(written);
        expect(await stateOf(target.id), label).toBe(named);

        const emptied = await client.updateItem(writer.id, {
          edges: { references: [] },
          version: patched.data.item.version,
        });
        expect(
          emptied.status,
          `${label}: ${JSON.stringify(emptied.error)}`,
        ).toBe(200);
        expect(
          (await client.listItemEdges(writer.id, { edge_type: "references" }))
            .data.data,
          label,
        ).toEqual([]);
      }
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

    async function family() {
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
      return {
        host,
        reached: [child, grandchild, bound],
        others: [grandparent, sibling, part],
      };
    }

    // The witness: the same transition into the bin takes what the host reaches.
    const control = await family();
    const trashed = await client.transitionItem(control.host.id, "trashed");
    expect(trashed.status, JSON.stringify(trashed.error)).toBe(200);
    for (const gone of control.reached) {
      expect((await client.getItem(gone.id)).status, gone.id).toBe(404);
    }

    const archive = await family();
    const moved = await client.transitionItem(archive.host.id, "archived");
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.item.state).toBe("archived");
    for (const other of [...archive.reached, ...archive.others]) {
      expect(await stateOf(other.id), other.id).toBe("active");
    }
  });

  it("changes the state of no other item on a bulk transition to archived", async () => {
    async function bulkTransition(state: "archived" | "trashed") {
      const tag = `archive-bulk-${state}-${ctx.runId}`;
      const host = await note("active", { tags: [tag] });
      const child = await note();
      await edgeBetween(host.id, child.id);
      const queued = await client.bulkAction({
        action: "transition",
        state,
        filter: { tags: [tag] },
      });
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
      const job = await client.pollBulkActionToTerminal(
        (queued.data as { id: string }).id,
      );
      expect(job.result?.succeeded).toBe(1);
      return { host, child };
    }

    // The witness: a bulk transition into the bin takes the host's child.
    const control = await bulkTransition("trashed");
    expect((await client.getItem(control.host.id)).status).toBe(404);
    expect((await client.getItem(control.child.id)).status).toBe(404);

    const archive = await bulkTransition("archived");
    expect(await stateOf(archive.host.id)).toBe("archived");
    expect(await stateOf(archive.child.id)).toBe("active");
  });
});
