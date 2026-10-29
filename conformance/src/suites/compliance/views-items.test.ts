/**
 * The view's items door: `GET /views/{id}/items` lists what a saved view
 * lists, in its sort order, to the keys that can read both the view and the
 * items.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackKey,
  trackView,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "views-items",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

let batches = 0;
const writers = new Map<string, MarfaClient>();

/**
 * A source of this test's own, so a view of it lists only what the test made.
 * A write names its own key's source, so each source has a key of its own.
 */
async function freshSource(): Promise<string> {
  batches += 1;
  const source = `${ctx.source}-v${String(batches)}`;
  const r = await client.createKey({
    label: `writer-${String(batches)}`,
    source,
    type_permissions: { "*": "write" },
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackKey(ctx, r.data.id);
  writers.set(source, new MarfaClient({ baseUrl: apiUrl, apiKey: r.data.key }));
  return source;
}

interface Made {
  id: string;
}

async function make(
  source: string,
  input: {
    type?: string;
    properties?: Record<string, unknown>;
    tags?: string[];
    tier?: "library" | "feed";
    occurred_at?: string;
  } = {},
): Promise<Made> {
  const r = await writers.get(source)!.createItem({
    type: input.type ?? "core.note",
    source,
    properties: input.properties ?? {},
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.tier ? { tier: input.tier } : {}),
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackItem(ctx, r.data.item.id);
  return { id: r.data.item.id };
}

async function note(
  source: string,
  title: string | null,
  more: Record<string, unknown> = {},
  rest: Parameters<typeof make>[1] = {},
): Promise<Made> {
  return make(source, {
    ...rest,
    properties: { ...(title === null ? {} : { title }), ...more },
  });
}

async function viewOf(
  source: string,
  settings: Record<string, unknown> = {},
  by: MarfaClient = client,
): Promise<string> {
  const { query, ...rest } = settings as { query?: Record<string, unknown> };
  const r = await by.createView({
    title: "Listed",
    ...rest,
    query: { filter: `source eq "${source}"`, ...(query ?? {}) },
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackView(ctx, r.data.item.id);
  return r.data.item.id;
}

/** Every item the view lists, page by page. */
async function listed(
  id: string,
  limit = 2,
  by: MarfaClient = client,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const r = await by.listViewItems(id, { limit, cursor });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    out.push(...r.data.data.map((item) => item.id));
    if (r.data.next_cursor === null) return out;
    cursor = r.data.next_cursor;
  }
  throw new Error("a view listing did not end");
}

async function keyWith(
  label: string,
  type_permissions: Record<string, string>,
  more: { edge_permissions?: Record<string, string> } = {},
): Promise<MarfaClient> {
  const r = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions,
    ...more,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackKey(ctx, r.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: r.data.key });
}

async function edge(parent: string, child: string): Promise<void> {
  const r = await client.createEdge({
    source_id: parent,
    target_id: child,
    edge_type: "parent-of",
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
}

describe("the view's items door", () => {
  it("lists the newest occurrence first when the view names no sort, and answers a page the document declares", async () => {
    const source = await freshSource();
    const old = await note(
      source,
      "Old",
      {},
      { occurred_at: "2024-01-01T00:00:00Z" },
    );
    const newest = await note(
      source,
      "New",
      {},
      { occurred_at: "2024-03-01T00:00:00Z" },
    );
    const middle = await note(
      source,
      "Mid",
      {},
      { occurred_at: "2024-02-01T00:00:00Z" },
    );
    const id = await viewOf(source);

    const r = await client.listViewItems(id);
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    await expectMatchesSchema("GET", "/views/{id}/items", 200, r.data);
    expect(Object.keys(r.data).sort()).toEqual(["data", "next_cursor"]);
    expect(r.data.data.map((item) => item.id)).toEqual([
      newest.id,
      middle.id,
      old.id,
    ]);
    expect(r.data.next_cursor).toBeNull();
  });

  it("pages in the view's order with a cursor, whatever the limit, with no item twice and none missed", async () => {
    const source = await freshSource();
    const made: Made[] = [];
    for (let i = 0; i < 7; i += 1) {
      made.push(
        await note(
          source,
          `Item ${String(i)}`,
          {},
          { occurred_at: `2024-01-0${String(i + 1)}T00:00:00Z` },
        ),
      );
    }
    const id = await viewOf(source, {
      sort: [{ by: "occurred_at", direction: "asc" }],
    });
    const expected = made.map((m) => m.id);
    for (const limit of [1, 2, 3, 7, 50]) {
      expect(await listed(id, limit), `limit ${String(limit)}`).toEqual(
        expected,
      );
    }
    const first = await client.listViewItems(id, { limit: 3 });
    expect(first.data.data).toHaveLength(3);
    expect(first.data.next_cursor).not.toBeNull();
    const exact = await client.listViewItems(id, { limit: 7 });
    expect(exact.data.next_cursor).toBeNull();
  });

  it("answers 50 items without a limit and refuses a limit above 200 or below 1", async () => {
    const source = await freshSource();
    const id = await viewOf(source);
    const bulk = await writers.get(source)!.bulkItems(
      Array.from({ length: 52 }, (_, i) => ({
        type: "core.note",
        source,
        properties: { title: `Bulk ${String(i)}` },
      })),
    );
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    for (const result of bulk.data.results) {
      if (result.id) trackItem(ctx, result.id);
    }
    const page = await client.listViewItems(id);
    expect(page.data.data).toHaveLength(50);
    expect(page.data.next_cursor).not.toBeNull();
    expect(
      (await client.listViewItems(id, { limit: 200 })).data.data,
    ).toHaveLength(52);
    for (const limit of [201, 0]) {
      const refused = await client.listViewItems(id, { limit });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
  });

  it("sorts by title, naming each type's own title field, with an untitled item last in either direction", async () => {
    const source = await freshSource();
    const bravo = await note(source, "Bravo");
    const alpha = await note(source, "Alpha");
    const untitled = await note(source, null);
    const charlie = await make(source, {
      type: "core.entity",
      properties: { name: "Charlie" },
    });
    const id = await viewOf(source, {
      sort: [{ by: "title", direction: "asc" }],
    });
    expect(await listed(id)).toEqual([
      alpha.id,
      bravo.id,
      charlie.id,
      untitled.id,
    ]);
    const down = await viewOf(source, {
      sort: [{ by: "title", direction: "desc" }],
    });
    expect(await listed(down)).toEqual([
      charlie.id,
      bravo.id,
      alpha.id,
      untitled.id,
    ]);
  });

  it("sorts by a title field a type registered at runtime names", async () => {
    const source = await freshSource();
    const typeId = `user.shelf_${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    const registered = await client.registerType({
      id: typeId,
      label: "Shelf",
      version: 0,
      fields: { label: { type: "string", description: "The shelf's label" } },
      display_hints: { title_field: "label" },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    try {
      const zed = await make(source, {
        type: typeId,
        properties: { label: "Zed" },
      });
      const mid = await note(source, "Mid");
      const ant = await make(source, {
        type: typeId,
        properties: { label: "Ant" },
      });
      const id = await viewOf(source, {
        query: { types: [typeId, "core.note"] },
        sort: [{ by: "title", direction: "asc" }],
      });
      expect(await listed(id)).toEqual([ant.id, mid.id, zed.id]);
    } finally {
      await client.deleteType(typeId, true);
    }
  });

  it("sorts by type, state, tier and tags", async () => {
    const source = await freshSource();
    const entity = await make(source, {
      type: "core.entity",
      properties: { name: "E" },
    });
    const plain = await note(source, "N");
    const byType = await viewOf(source, {
      sort: [{ by: "type", direction: "asc" }],
    });
    expect(await listed(byType)).toEqual([entity.id, plain.id]);
    expect(
      await listed(
        await viewOf(source, { sort: [{ by: "type", direction: "desc" }] }),
      ),
    ).toEqual([plain.id, entity.id]);

    const archived = await note(source, "Archived");
    expect((await client.transitionItem(archived.id, "archived")).status).toBe(
      200,
    );
    const byState = await viewOf(source, {
      sort: [
        { by: "state", direction: "asc" },
        { by: "title", direction: "asc" },
      ],
    });
    expect(await listed(byState)).toEqual([entity.id, plain.id, archived.id]);

    const feedSource = await freshSource();
    const library = await note(feedSource, "Library", {}, { tier: "library" });
    const feed = await note(feedSource, "Feed", {}, { tier: "feed" });
    const byTier = await viewOf(feedSource, {
      sort: [{ by: "tier", direction: "asc" }],
    });
    expect(await listed(byTier)).toEqual([feed.id, library.id]);
    expect(
      await listed(
        await viewOf(feedSource, { sort: [{ by: "tier", direction: "desc" }] }),
      ),
    ).toEqual([library.id, feed.id]);
    expect(
      await listed(await viewOf(feedSource, { query: { tier: "feed" } })),
    ).toEqual([feed.id]);

    const tagSource = await freshSource();
    const bee = await note(tagSource, "T1", {}, { tags: ["b", "z"] });
    const ay = await note(tagSource, "T2", {}, { tags: ["c", "a"] });
    const none = await note(tagSource, "T3");
    const byTags = await viewOf(tagSource, {
      sort: [{ by: "tags", direction: "asc" }],
    });
    expect(await listed(byTags)).toEqual([ay.id, bee.id, none.id]);
    expect(
      await listed(
        await viewOf(tagSource, { sort: [{ by: "tags", direction: "desc" }] }),
      ),
    ).toEqual([bee.id, ay.id, none.id]);
  });
  it("sorts by a property, numbers by value and an item without the property last in either direction", async () => {
    const source = await freshSource();
    const ten = await note(source, "Ten", { notes: "10" });
    const two = await note(source, "Two", { notes: "2" });
    const bare = await note(source, "Bare");
    const asc = await viewOf(source, {
      sort: [{ by: "properties.notes", direction: "asc" }],
    });
    expect(await listed(asc)).toEqual([ten.id, two.id, bare.id]);
    const desc = await viewOf(source, {
      sort: [{ by: "properties.notes", direction: "desc" }],
    });
    expect(await listed(desc)).toEqual([two.id, ten.id, bare.id]);
  });

  it("breaks a tie by the item's ID, and a tie on the one timestamp key in that key's direction", async () => {
    const source = await freshSource();
    const at = "2024-05-05T00:00:00Z";
    const first = await note(source, "Same", {}, { occurred_at: at });
    const second = await note(source, "Same", {}, { occurred_at: at });
    const third = await note(source, "Same", {}, { occurred_at: at });
    const byTitle = await viewOf(source, {
      sort: [{ by: "title", direction: "desc" }],
    });
    expect(await listed(byTitle, 1)).toEqual([first.id, second.id, third.id]);
    const up = await viewOf(source, {
      sort: [{ by: "occurred_at", direction: "asc" }],
    });
    expect(await listed(up, 1)).toEqual([first.id, second.id, third.id]);
    const down = await viewOf(source, {
      sort: [{ by: "occurred_at", direction: "desc" }],
    });
    expect(await listed(down, 1)).toEqual([third.id, second.id, first.id]);
  });

  it("orders by every key in turn, up to ten, and pages through a tie on the leading keys", async () => {
    const source = await freshSource();
    const a = await note(source, "A", { notes: "2" });
    const b = await note(source, "A", { notes: "1" });
    const c = await note(source, "B", { notes: "1" });
    const keys = [
      { by: "title", direction: "asc" },
      { by: "properties.notes", direction: "asc" },
      ...Array.from({ length: 8 }, () => ({
        by: "properties.language",
        direction: "desc",
      })),
    ];
    expect(keys).toHaveLength(10);
    const id = await viewOf(source, { sort: keys });
    for (const limit of [1, 2, 3]) {
      expect(await listed(id, limit), `limit ${String(limit)}`).toEqual([
        b.id,
        a.id,
        c.id,
      ]);
    }
  });

  it("lists active and archived items by default, and the states a view names", async () => {
    const source = await freshSource();
    const live = await note(source, "Live");
    const kept = await note(source, "Kept");
    const gone = await note(source, "Gone");
    expect((await client.transitionItem(kept.id, "archived")).status).toBe(200);
    expect((await client.deleteItem(gone.id)).status).toBe(200);
    const sort = [{ by: "title", direction: "asc" }];
    expect(await listed(await viewOf(source, { sort }))).toEqual([
      kept.id,
      live.id,
    ]);
    expect(
      await listed(
        await viewOf(source, { sort, query: { state: ["archived"] } }),
      ),
    ).toEqual([kept.id]);
    expect(
      await listed(
        await viewOf(source, { sort, query: { state: ["active"] } }),
      ),
    ).toEqual([live.id]);
  });

  it("lists the types a view names with their subtypes, and narrows by its filter", async () => {
    const source = await freshSource();
    const person = await make(source, {
      type: "core.entity.person",
      properties: { name: "Pat" },
      tags: ["keep"],
    });
    const entity = await make(source, {
      type: "core.entity",
      properties: { name: "Org" },
    });
    const plain = await note(source, "Plain", {}, { tags: ["keep"] });
    const sort = [{ by: "title", direction: "asc" }];
    expect(
      await listed(
        await viewOf(source, { sort, query: { types: ["core.entity"] } }),
      ),
    ).toEqual([entity.id, person.id]);
    expect(
      await listed(
        await viewOf(source, {
          sort,
          query: { filter: `tags contains "keep"` },
        }),
      ),
    ).toEqual([person.id, plain.id]);
  });

  it("lists the item beneath and everything under it by parent-of, at any depth", async () => {
    const source = await freshSource();
    const root = await note(source, "Root");
    const child = await note(source, "Child");
    const grandchild = await note(source, "Grandchild");
    const outside = await note(source, "Outside");
    await edge(root.id, child.id);
    await edge(child.id, grandchild.id);
    const sort = [{ by: "title", direction: "asc" }];
    const id = await viewOf(source, { sort, query: { beneath: root.id } });
    expect(await listed(id, 1)).toEqual([child.id, grandchild.id, root.id]);
    expect(
      await listed(await viewOf(source, { sort })),
      "the witness",
    ).toContain(outside.id);
    expect(await listed(id, 1)).not.toContain(outside.id);
  });

  it("leaves out a trashed item beneath and a trashed item itself, and lists nothing beneath an item that does not exist", async () => {
    const source = await freshSource();
    const root = await note(source, "Root");
    const child = await note(source, "Child");
    const trashedChild = await note(source, "Trashed child");
    await edge(root.id, child.id);
    await edge(root.id, trashedChild.id);
    expect((await client.deleteItem(trashedChild.id)).status).toBe(200);
    const sort = [{ by: "title", direction: "asc" }];
    const id = await viewOf(source, { sort, query: { beneath: root.id } });
    expect(await listed(id)).toEqual([child.id, root.id]);

    expect((await client.deleteItem(root.id)).status).toBe(200);
    expect(await listed(id)).toEqual([]);

    const missing = await viewOf(source, {
      sort,
      query: { beneath: "01920000-0000-7000-8000-00000000abcd" },
    });
    const r = await client.listViewItems(missing);
    expect(r.status).toBe(200);
    expect(r.data.data).toEqual([]);
    expect(r.data.next_cursor).toBeNull();
  });

  it("leaves out the types a key cannot read, and walks beneath only through items it can read", async () => {
    const source = await freshSource();
    const root = await note(source, "Root");
    const middle = await make(source, {
      type: "core.entity",
      properties: { name: "Middle" },
    });
    const leaf = await note(source, "Leaf");
    const direct = await note(source, "Direct");
    await edge(root.id, middle.id);
    await edge(middle.id, leaf.id);
    await edge(root.id, direct.id);
    const sort = [{ by: "title", direction: "asc" }];
    const flat = await viewOf(source, { sort });
    const beneath = await viewOf(source, { sort, query: { beneath: root.id } });
    expect(await listed(flat)).toEqual([
      direct.id,
      leaf.id,
      middle.id,
      root.id,
    ]);
    expect(await listed(beneath)).toEqual([
      direct.id,
      leaf.id,
      middle.id,
      root.id,
    ]);

    const reader = await keyWith(
      "notes-only",
      { "core.note": "read", "system.view": "read" },
      { edge_permissions: { "parent-of": "read" } },
    );
    expect(await listed(flat, 2, reader)).toEqual([
      direct.id,
      leaf.id,
      root.id,
    ]);
    expect(await listed(beneath, 2, reader)).toEqual([direct.id, root.id]);
  });

  it("refuses a view that goes beneath an item to a key that cannot read parent-of edges", async () => {
    const source = await freshSource();
    const root = await note(source, "Root");
    const id = await viewOf(source, { query: { beneath: root.id } });
    expect((await client.listViewItems(id)).status).toBe(200);
    const blind = await keyWith(
      "no-parent-of",
      { "*": "read" },
      { edge_permissions: { about: "read" } },
    );
    const r = await blind.listViewItems(id);
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("edge_permission_denied");
    await expectMatchesSchema("GET", "/views/{id}/items", 403, r.error);
  });

  it("never lists a system item, though the view's own query would reach one", async () => {
    const own = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "Mine" },
    });
    expect(own.status, JSON.stringify(own.error)).toBe(201);
    trackItem(ctx, own.data.item.id);
    const id = await viewOf(ctx.source);
    const witness = await client.rawRequest<{ data: { id: string }[] }>(
      `/items?type=system.view&filter=${encodeURIComponent(`source eq "${ctx.source}"`)}&limit=200`,
    );
    expect(witness.data.data.map((row) => row.id)).toContain(id);
    expect(await listed(id, 50)).toEqual([own.data.item.id]);
  });

  it("answers 404 for a view the key cannot read, an item that is not a view and an ID nothing holds", async () => {
    const source = await freshSource();
    const id = await viewOf(source);
    const other = await note(source, "Not a view");
    const blind = await keyWith("blind", { "core.note": "read" });
    for (const target of [
      [client, other.id],
      [client, "01920000-0000-7000-8000-00000000abcd"],
      [blind, id],
    ] as const) {
      const r = await target[0].listViewItems(target[1]);
      expect(r.status).toBe(404);
      expect(r.error?.error.code).toBe("item_not_found");
      await expectMatchesSchema("GET", "/views/{id}/items", 404, r.error);
    }
    const bad = await client.listViewItems("not-an-id");
    expect(bad.status).toBe(400);
    expect(bad.error?.error.code).toBe("invalid_id");
    await expectMatchesSchema("GET", "/views/{id}/items", 400, bad.error);
  });

  it("lists nothing for a key that reads the view but no item, and refuses a key that reads no type", async () => {
    const source = await freshSource();
    await note(source, "Hidden");
    const id = await viewOf(source);
    const viewOnly = await keyWith("view-only", { "system.view": "read" });
    const r = await viewOnly.listViewItems(id);
    expect(r.status).toBe(200);
    expect(r.data.data).toEqual([]);
    const witness = await client.listViewItems(id);
    expect(witness.data.data).toHaveLength(1);

    const none = await keyWith("reads-nothing", { "*": "none" });
    const refused = await none.listViewItems(id);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    await expectMatchesSchema("GET", "/views/{id}/items", 403, refused.error);
  });

  it("refuses a listing of a view whose parent was deleted", async () => {
    const source = await freshSource();
    const parent = await note(source, "Parent of a view");
    const id = await viewOf(source);
    await edge(parent.id, id);
    expect((await client.listViewItems(id)).status).toBe(200);
    expect((await client.deleteItem(parent.id)).status).toBe(200);
    const r = await client.listViewItems(id);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_transition");
    await expectMatchesSchema("GET", "/views/{id}/items", 400, r.error);
  });

  it("refuses a cursor from another view, another ordering or no listing at all", async () => {
    const source = await freshSource();
    await note(source, "One");
    await note(source, "Two");
    const sort = [{ by: "title", direction: "asc" }];
    const id = await viewOf(source, { sort });
    const page = await client.listViewItems(id, { limit: 1 });
    const cursor = page.data.next_cursor;
    expect(cursor).not.toBeNull();
    const witness = await client.listViewItems(id, {
      limit: 1,
      cursor: cursor!,
    });
    expect(witness.status).toBe(200);
    expect(witness.data.data).toHaveLength(1);

    const otherView = await viewOf(source, { sort });
    const otherOrder = await viewOf(source, {
      sort: [{ by: "title", direction: "desc" }],
    });
    for (const target of [otherView, otherOrder]) {
      const r = await client.listViewItems(target, { cursor: cursor! });
      expect(r.status).toBe(400);
      expect(r.error?.error.code).toBe("validation_error");
    }
    const junk = await client.listViewItems(id, { cursor: "junk" });
    expect(junk.status).toBe(400);
    expect(junk.error?.error.code).toBe("validation_error");
  });
});
