/**
 * The source filter on the edge listings.
 *
 * An edge is a statement its source item makes about its target, so a source
 * filter decides an edge by the source of its source item and never by the
 * target's. The three listings, `GET /edges`, `GET /items/{id}/edges` and
 * `GET /items/{id}/backrefs`, apply it in the query, so a page is as full as
 * the listing allows and a cursor walks the whole of it. A read by id is not
 * narrowed.
 *
 * Every absence below is paired with the same read by a key that has no
 * filter, which sees the edge: without that, a listing that returned nothing
 * at all would pass.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

let ctx: TestContext;

const tag = Math.random().toString(36).slice(2, 10);
const SHOWN = `shown-${tag}`;
const HIDDEN = `hidden-${tag}`;
const ALSO_SHOWN = `also-shown-${tag}`;

/** Writes under each source, and a reader with no filter at all. */
let shownWriter: string;
let hiddenWriter: string;
let alsoShownWriter: string;
let unfiltered: string;
/** Readers whose own filter names the sources it admits. */
let filtered: string;
let filteredTwo: string;
let filteredBookmarkOnly: string;

interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
}
interface EdgePage {
  data: Edge[];
  next_cursor: string | null;
}

async function mintKey(
  label: string,
  source: string,
  filter?: { types: string[]; sources: string[] },
): Promise<string> {
  return mintWorkingKey(ctx, {
    label: `${label}-${tag}`,
    source,
    permissions: [],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    ...(filter ? { enforcement_override: { source_filter: filter } } : {}),
  });
}

async function createItem(key: string, type = "core.note"): Promise<string> {
  const properties =
    type === "core.bookmark"
      ? { url: `https://example.test/${Math.random().toString(36).slice(2)}` }
      : { body: `note ${Math.random().toString(36).slice(2)}` };
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type, properties },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function createEdge(
  key: string,
  source: string,
  target: string,
  edgeType = "about",
): Promise<string> {
  const res = await request(ctx.app, "POST", "/edges", {
    key,
    body: { source_id: source, target_id: target, edge_type: edgeType },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { edge: { id: string } }).edge.id;
}

async function page(key: string, path: string): Promise<EdgePage> {
  const res = await request(ctx.app, "GET", path, { key });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as EdgePage;
}

/** Every page of a listing, in order. */
async function pages(
  key: string,
  path: string,
  limit: number,
): Promise<EdgePage[]> {
  const out: EdgePage[] = [];
  let cursor: string | null = null;
  do {
    const query = `limit=${String(limit)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const next = await page(
      key,
      `${path}${path.includes("?") ? "&" : "?"}${query}`,
    );
    out.push(next);
    cursor = next.next_cursor;
  } while (cursor);
  return out;
}

async function ids(key: string, path: string): Promise<string[]> {
  return (
    await page(key, `${path}${path.includes("?") ? "&" : "?"}limit=500`)
  ).data
    .map((e) => e.id)
    .sort();
}

async function trash(key: string, id: string): Promise<void> {
  const res = await request(ctx.app, "POST", `/items/${id}/transition`, {
    key,
    body: { state: "trashed" },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

beforeAll(async () => {
  ctx = await createTestContext();
  shownWriter = await mintKey("shown-writer", SHOWN);
  hiddenWriter = await mintKey("hidden-writer", HIDDEN);
  alsoShownWriter = await mintKey("also-shown-writer", ALSO_SHOWN);
  unfiltered = await mintKey("unfiltered", `reader-${tag}`);
  filtered = await mintKey("filtered", `reader-one-${tag}`, {
    types: ["core.note"],
    sources: [SHOWN],
  });
  filteredTwo = await mintKey("filtered-two", `reader-two-${tag}`, {
    types: ["core.note"],
    sources: [SHOWN, ALSO_SHOWN],
  });
  filteredBookmarkOnly = await mintKey(
    "filtered-bookmark",
    `reader-bm-${tag}`,
    {
      types: ["core.bookmark"],
      sources: [SHOWN],
    },
  );
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

describe("GET /edges", () => {
  it("keeps an edge whose source item the filter shows, whatever the target's source, and leaves out one whose source item it hides", async () => {
    const fromShown = await createItem(shownWriter);
    const fromHidden = await createItem(hiddenWriter);
    const toShown = await createItem(shownWriter);
    const toHidden = await createItem(hiddenWriter);

    const shownToShown = await createEdge(shownWriter, fromShown, toShown);
    const shownToHidden = await createEdge(shownWriter, fromShown, toHidden);
    const hiddenToShown = await createEdge(hiddenWriter, fromHidden, toShown);
    const hiddenToHidden = await createEdge(hiddenWriter, fromHidden, toHidden);
    const all = [shownToShown, shownToHidden, hiddenToShown, hiddenToHidden];

    // The witness: with no filter every one of the four is listed.
    const seen = await ids(unfiltered, "/edges");
    for (const id of all) expect(seen).toContain(id);

    const narrowed = await ids(filtered, "/edges");
    expect(narrowed).toContain(shownToShown);
    expect(narrowed).toContain(shownToHidden);
    expect(narrowed).not.toContain(hiddenToShown);
    expect(narrowed).not.toContain(hiddenToHidden);
  });

  it("applies in the catch-up order as it does in the default order", async () => {
    const fromShown = await createItem(shownWriter);
    const fromHidden = await createItem(hiddenWriter);
    const target = await createItem(hiddenWriter);
    const kept = await createEdge(shownWriter, fromShown, target);
    const dropped = await createEdge(hiddenWriter, fromHidden, target);

    const path = "/edges?updated_after=1970-01-01T00:00:00.000Z";
    const seen = await ids(unfiltered, path);
    expect(seen).toContain(kept);
    expect(seen).toContain(dropped);

    const narrowed = await ids(filtered, path);
    expect(narrowed).toContain(kept);
    expect(narrowed).not.toContain(dropped);
  });

  it("names every source a filter lists, and no other", async () => {
    const fromShown = await createItem(shownWriter);
    const fromAlsoShown = await createItem(alsoShownWriter);
    const fromHidden = await createItem(hiddenWriter);
    const target = await createItem(hiddenWriter);
    const a = await createEdge(shownWriter, fromShown, target);
    const b = await createEdge(alsoShownWriter, fromAlsoShown, target);
    const c = await createEdge(hiddenWriter, fromHidden, target);

    // The witness: a filter naming one of the two sources leaves the other out.
    const one = await ids(filtered, "/edges");
    expect(one).toContain(a);
    expect(one).not.toContain(b);

    const two = await ids(filteredTwo, "/edges");
    expect(two).toContain(a);
    expect(two).toContain(b);
    expect(two).not.toContain(c);
  });

  it("filters only the types the filter names, whatever the source of an item of another type", async () => {
    const hiddenNote = await createItem(hiddenWriter);
    const hiddenBookmark = await createItem(hiddenWriter, "core.bookmark");
    const target = await createItem(hiddenWriter);
    const fromNote = await createEdge(hiddenWriter, hiddenNote, target);
    const fromBookmark = await createEdge(hiddenWriter, hiddenBookmark, target);

    // `filtered` names notes only: the bookmark is not covered and shows.
    const notes = await ids(filtered, "/edges");
    expect(notes).not.toContain(fromNote);
    expect(notes).toContain(fromBookmark);

    // The witness for the other direction: a filter naming bookmarks hides
    // the edge from the bookmark and shows the one from the note.
    const bookmarks = await ids(filteredBookmarkOnly, "/edges");
    expect(bookmarks).toContain(fromNote);
    expect(bookmarks).not.toContain(fromBookmark);
  });

  it("judges an edge by its source item while that item is in the bin", async () => {
    const shownSource = await createItem(shownWriter);
    const hiddenSource = await createItem(hiddenWriter);
    const target = await createItem(hiddenWriter);
    const keptEdge = await createEdge(shownWriter, shownSource, target);
    const droppedEdge = await createEdge(hiddenWriter, hiddenSource, target);
    await trash(shownWriter, shownSource);
    await trash(hiddenWriter, hiddenSource);

    // The witness: both edges are still listed to a key with no filter, so
    // the absence below is the filter's and not the bin's.
    const seen = await ids(unfiltered, "/edges");
    expect(seen).toContain(keptEdge);
    expect(seen).toContain(droppedEdge);

    const narrowed = await ids(filtered, "/edges");
    expect(narrowed).toContain(keptEdge);
    expect(narrowed).not.toContain(droppedEdge);
  });

  it("lists no edge of an item once the item is purged, whatever the filter", async () => {
    const source = await createItem(shownWriter);
    const target = await createItem(shownWriter);
    const edge = await createEdge(shownWriter, source, target);
    expect(await ids(filtered, "/edges")).toContain(edge);

    await trash(shownWriter, source);
    const purged = await request(ctx.app, "POST", `/items/${source}/purge`, {
      key: ctx.workingKey,
    });
    expect(purged.status, await purged.clone().text()).toBe(200);

    expect(await ids(filtered, "/edges")).not.toContain(edge);
    expect(await ids(unfiltered, "/edges")).not.toContain(edge);
  });

  it("fills each page it can and walks the whole listing, where hidden edges alternate with shown ones", async () => {
    const edgeType = "attached-to";
    const target = await createItem(hiddenWriter);
    const shownIds: string[] = [];
    const hiddenIds: string[] = [];
    // Newest first, so the listing alternates shown, hidden, shown, hidden...
    // and a page cut before the filter would hold one shown edge of every two.
    for (let n = 0; n < 12; n++) {
      const fromShown = await createItem(shownWriter);
      shownIds.push(await createEdge(shownWriter, fromShown, target, edgeType));
      const fromHidden = await createItem(hiddenWriter);
      hiddenIds.push(
        await createEdge(hiddenWriter, fromHidden, target, edgeType),
      );
    }
    const path = `/edges?edge_type=${edgeType}`;

    // The witness: with no filter the same listing pages in full, and each
    // page of four holds two shown edges and two hidden ones.
    const whole = await pages(unfiltered, path, 4);
    expect(whole.flatMap((p) => p.data.map((e) => e.id)).sort()).toEqual(
      [...shownIds, ...hiddenIds].sort(),
    );

    const narrowed = await pages(filtered, path, 4);
    expect(narrowed.map((p) => p.data.length)).toEqual([4, 4, 4]);
    expect(narrowed.at(-1)?.next_cursor).toBeNull();
    expect(narrowed.flatMap((p) => p.data.map((e) => e.id)).sort()).toEqual(
      [...shownIds].sort(),
    );
  });

  it("fills each page in the catch-up order too", async () => {
    const edgeType = "derived-from";
    const target = await createItem(hiddenWriter);
    const shownIds: string[] = [];
    for (let n = 0; n < 6; n++) {
      const fromHidden = await createItem(hiddenWriter);
      await createEdge(hiddenWriter, fromHidden, target, edgeType);
      const fromShown = await createItem(shownWriter);
      shownIds.push(await createEdge(shownWriter, fromShown, target, edgeType));
    }
    const path = `/edges?edge_type=${edgeType}&updated_after=1970-01-01T00:00:00.000Z`;
    const narrowed = await pages(filtered, path, 3);
    expect(narrowed.map((p) => p.data.length)).toEqual([3, 3]);
    expect(narrowed.flatMap((p) => p.data.map((e) => e.id)).sort()).toEqual(
      [...shownIds].sort(),
    );
  });
});

describe("GET /items/{id}/edges", () => {
  it("lists an edge of a shown source whose target is hidden, and nothing from a hidden source", async () => {
    const shownSource = await createItem(shownWriter);
    const hiddenSource = await createItem(hiddenWriter);
    const hiddenTarget = await createItem(hiddenWriter);
    const fromShown = await createEdge(shownWriter, shownSource, hiddenTarget);
    const fromHidden = await createEdge(
      hiddenWriter,
      hiddenSource,
      hiddenTarget,
    );

    // The witness: a key with no filter lists the edge of each anchor.
    expect(await ids(unfiltered, `/items/${shownSource}/edges`)).toEqual([
      fromShown,
    ]);
    expect(await ids(unfiltered, `/items/${hiddenSource}/edges`)).toEqual([
      fromHidden,
    ]);

    expect(await ids(filtered, `/items/${shownSource}/edges`)).toEqual([
      fromShown,
    ]);
    // The anchor is read by id, which the filter does not narrow, and every
    // edge it holds has a source the filter hides.
    const anchor = await request(ctx.app, "GET", `/items/${hiddenSource}`, {
      key: filtered,
    });
    expect(anchor.status).toBe(200);
    expect(await ids(filtered, `/items/${hiddenSource}/edges`)).toEqual([]);
  });

  it("fills each page it can, where the source is shown", async () => {
    const anchor = await createItem(shownWriter);
    const made: string[] = [];
    for (let n = 0; n < 7; n++) {
      made.push(
        await createEdge(shownWriter, anchor, await createItem(hiddenWriter)),
      );
    }
    const walked = await pages(filtered, `/items/${anchor}/edges`, 3);
    expect(walked.map((p) => p.data.length)).toEqual([3, 3, 1]);
    expect(walked.flatMap((p) => p.data.map((e) => e.id)).sort()).toEqual(
      [...made].sort(),
    );
  });
});

describe("GET /items/{id}/backrefs", () => {
  it("lists the inbound edges whose source the filter shows, and not those whose source it hides", async () => {
    const target = await createItem(hiddenWriter);
    const shownSource = await createItem(shownWriter);
    const hiddenSource = await createItem(hiddenWriter);
    const fromShown = await createEdge(shownWriter, shownSource, target);
    const fromHidden = await createEdge(hiddenWriter, hiddenSource, target);

    // The witness: with no filter both inbound edges are listed.
    expect(await ids(unfiltered, `/items/${target}/backrefs`)).toEqual(
      [fromShown, fromHidden].sort(),
    );

    // The target's own source is hidden and does not matter.
    expect(await ids(filtered, `/items/${target}/backrefs`)).toEqual([
      fromShown,
    ]);
  });

  it("fills each page it can, where hidden and shown sources alternate", async () => {
    const target = await createItem(shownWriter);
    const shownIds: string[] = [];
    for (let n = 0; n < 10; n++) {
      shownIds.push(
        await createEdge(shownWriter, await createItem(shownWriter), target),
      );
      await createEdge(hiddenWriter, await createItem(hiddenWriter), target);
    }

    const whole = await pages(unfiltered, `/items/${target}/backrefs`, 4);
    expect(whole.flatMap((p) => p.data)).toHaveLength(20);

    const walked = await pages(filtered, `/items/${target}/backrefs`, 4);
    expect(walked.map((p) => p.data.length)).toEqual([4, 4, 2]);
    expect(walked.flatMap((p) => p.data.map((e) => e.id)).sort()).toEqual(
      [...shownIds].sort(),
    );
  });

  it("judges an edge by its source item while that item is in the bin", async () => {
    const target = await createItem(hiddenWriter);
    const shownSource = await createItem(shownWriter);
    const hiddenSource = await createItem(hiddenWriter);
    const fromShown = await createEdge(shownWriter, shownSource, target);
    const fromHidden = await createEdge(hiddenWriter, hiddenSource, target);
    await trash(shownWriter, shownSource);
    await trash(hiddenWriter, hiddenSource);

    expect(await ids(unfiltered, `/items/${target}/backrefs`)).toEqual(
      [fromShown, fromHidden].sort(),
    );
    expect(await ids(filtered, `/items/${target}/backrefs`)).toEqual([
      fromShown,
    ]);
  });
});

describe("GET /edges/{id}", () => {
  it("answers an edge whose source item the filter hides, as it answers an item by id", async () => {
    const source = await createItem(hiddenWriter);
    const target = await createItem(shownWriter);
    const edge = await createEdge(hiddenWriter, source, target);

    // The witness: the listing leaves the same edge out.
    expect(await ids(filtered, "/edges")).not.toContain(edge);

    const res = await request(ctx.app, "GET", `/edges/${edge}`, {
      key: filtered,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { edge: Edge }).edge.id).toBe(edge);
  });
});

type Blocks = Record<string, EdgePage>;

interface ItemRead {
  item: { id: string; edges?: Blocks };
  backrefs?: Blocks;
  neighbors?: { item: { id: string } }[];
}

async function readItem(
  key: string,
  id: string,
  include = "",
): Promise<ItemRead> {
  const res = await request(
    ctx.app,
    "GET",
    `/items/${id}${include ? `?include=${include}` : ""}`,
    { key },
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ItemRead;
}

const blockIds = (blocks: Blocks | undefined, type = "about"): string[] =>
  (blocks?.[type]?.data ?? []).map((e) => e.id).sort();

describe("the edges an item read carries", () => {
  it("leaves out of the inbound block an edge whose source item the filter hides, and out of the neighbors with it", async () => {
    const target = await createItem(shownWriter);
    const shownSource = await createItem(shownWriter);
    const hiddenSource = await createItem(hiddenWriter);
    const fromShown = await createEdge(shownWriter, shownSource, target);
    const fromHidden = await createEdge(hiddenWriter, hiddenSource, target);

    // The witness: with no filter the block holds both, and so do the neighbors.
    const whole = await readItem(unfiltered, target, "backrefs,neighbors");
    expect(blockIds(whole.backrefs)).toEqual([fromShown, fromHidden].sort());
    expect(whole.neighbors?.map((n) => n.item.id).sort()).toEqual(
      [shownSource, hiddenSource].sort(),
    );

    const narrowed = await readItem(filtered, target, "backrefs,neighbors");
    expect(blockIds(narrowed.backrefs)).toEqual([fromShown]);
    expect(narrowed.neighbors?.map((n) => n.item.id)).toEqual([shownSource]);
    // The same key's listing of the same edges agrees with the block.
    expect(await ids(filtered, `/items/${target}/backrefs`)).toEqual([
      fromShown,
    ]);
  });

  it("removes an inbound block whose every edge the filter hides", async () => {
    const target = await createItem(shownWriter);
    const hiddenSource = await createItem(hiddenWriter);
    await createEdge(hiddenWriter, hiddenSource, target);

    expect(
      Object.keys(
        (await readItem(unfiltered, target, "backrefs")).backrefs ?? {},
      ),
    ).toEqual(["about"]);
    expect(
      (await readItem(filtered, target, "backrefs")).backrefs ?? {},
    ).toEqual({});
  });

  it("carries the outbound edges of an item the filter shows, whatever the source of their targets", async () => {
    const source = await createItem(shownWriter);
    const hiddenTarget = await createItem(hiddenWriter);
    const edge = await createEdge(shownWriter, source, hiddenTarget);

    const read = await readItem(filtered, source, "neighbors");
    expect(blockIds(read.item.edges)).toEqual([edge]);
    expect(read.neighbors?.map((n) => n.item.id)).toEqual([hiddenTarget]);
  });

  it("carries no outbound edge of an item the filter hides, which the item read by id still answers", async () => {
    const source = await createItem(hiddenWriter);
    const target = await createItem(shownWriter);
    const edge = await createEdge(hiddenWriter, source, target);

    // The witness: a key with no filter is handed the edge with the item.
    expect(blockIds((await readItem(unfiltered, source)).item.edges)).toEqual([
      edge,
    ]);
    // The item is read by id and the edges it holds follow `GET /items/{id}/edges`.
    const read = await readItem(filtered, source);
    expect(read.item.id).toBe(source);
    expect(read.item.edges ?? {}).toEqual({});
    expect(await ids(filtered, `/items/${source}/edges`)).toEqual([]);
  });

  it("applies to an item listing and to a bulk read by id", async () => {
    const shown = await createItem(shownWriter);
    const hidden = await createItem(hiddenWriter);
    const toShown = await createItem(shownWriter);
    const fromShown = await createEdge(shownWriter, shown, toShown);
    await createEdge(hiddenWriter, hidden, toShown);

    const listing = await request(
      ctx.app,
      "GET",
      `/items?include=edges&limit=100`,
      { key: filtered },
    );
    expect(listing.status).toBe(200);
    const rows = (
      (await listing.json()) as { data: { id: string; edges?: Blocks }[] }
    ).data;
    expect(rows.find((i) => i.id === hidden)).toBeUndefined();
    expect(blockIds(rows.find((i) => i.id === shown)?.edges)).toEqual([
      fromShown,
    ]);

    const bulk = await request(ctx.app, "POST", "/items/bulk-get", {
      key: filtered,
      body: { ids: [shown, hidden], include: ["edges"] },
    });
    expect(bulk.status, await bulk.clone().text()).toBe(200);
    const items = (
      (await bulk.json()) as { items: { id: string; edges?: Blocks }[] }
    ).items;
    expect(blockIds(items.find((i) => i.id === shown)?.edges)).toEqual([
      fromShown,
    ]);
    // Read by id, so the hidden item is answered, and its edges are not.
    expect(items.find((i) => i.id === hidden)?.edges ?? {}).toEqual({});

    // The witness: a key with no filter is handed the hidden item's edge.
    const whole = await request(ctx.app, "POST", "/items/bulk-get", {
      key: unfiltered,
      body: { ids: [hidden], include: ["edges"] },
    });
    const wholeItems = (
      (await whole.json()) as { items: { id: string; edges?: Blocks }[] }
    ).items;
    expect(blockIds(wholeItems[0]?.edges)).toHaveLength(1);
  });

  it("applies to the edges a lookup by id carries", async () => {
    const shown = await createItem(shownWriter);
    const hidden = await createItem(hiddenWriter);
    const target = await createItem(shownWriter);
    const shownEdge = await createEdge(shownWriter, shown, target);
    const hiddenEdge = await createEdge(hiddenWriter, hidden, target);

    const lookup = async (key: string, ids: string[]) => {
      const res = await request(ctx.app, "POST", "/items/lookup", {
        key,
        body: { type: "core.note", ids, include: ["edges"] },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { data: { id: string; edges?: Blocks }[] })
        .data;
    };

    // The witness: with no filter the hidden item carries its edge.
    expect(blockIds((await lookup(unfiltered, [hidden]))[0]?.edges)).toEqual([
      hiddenEdge,
    ]);

    const rows = await lookup(filtered, [shown, hidden]);
    expect(blockIds(rows.find((i) => i.id === shown)?.edges)).toEqual([
      shownEdge,
    ]);
    expect(rows.find((i) => i.id === hidden)).toBeDefined();
    expect(rows.find((i) => i.id === hidden)?.edges ?? {}).toEqual({});
  });

  it("applies to the edges the answer to a write carries", async () => {
    const source = await createItem(hiddenWriter);
    const target = await createItem(shownWriter);
    const edge = await createEdge(hiddenWriter, source, target);

    const patch = async (key: string): Promise<Blocks | undefined> => {
      const current = await request(ctx.app, "GET", `/items/${source}`, {
        key,
      });
      const version = ((await current.json()) as { item: { version: number } })
        .item.version;
      const res = await request(ctx.app, "PATCH", `/items/${source}`, {
        key,
        body: { version, properties: { body: `patched ${String(version)}` } },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { item: { edges?: Blocks } }).item.edges;
    };

    // The witness: the same write by a key with no filter answers with the edge.
    expect(blockIds(await patch(unfiltered))).toEqual([edge]);
    expect(await patch(filtered)).toEqual({});
  });

  it("applies to the edges the answer to a create carries", async () => {
    const target = await createItem(shownWriter);
    const create = async (key: string): Promise<Blocks | undefined> => {
      const res = await request(ctx.app, "POST", "/items", {
        key,
        body: {
          type: "core.note",
          properties: { body: "with an edge" },
          edges: { about: [target] },
        },
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { item: { edges?: Blocks } }).item.edges;
    };

    // The witness: a key with no filter is answered with the edge it made.
    expect(Object.keys((await create(unfiltered)) ?? {})).toEqual(["about"]);
    // A filter that admits the key's own source keeps it, so the answer below
    // is the filter's refusal of the new item and not of every create.
    const admitsOwn = await mintKey("admits-own", `admits-own-${tag}`, {
      types: ["core.note"],
      sources: [`admits-own-${tag}`],
    });
    expect(Object.keys((await create(admitsOwn)) ?? {})).toEqual(["about"]);
    // `filtered` admits only another source, so the item it creates is hidden
    // from it and so are the edges it holds.
    expect(await create(filtered)).toEqual({});
  });

  it("fills a block to its cap with admitted edges and continues it at the listing", async () => {
    const target = await createItem(shownWriter);
    const shownIds: string[] = [];
    // Alternating, so a block cut before the filter would hold about half.
    for (let n = 0; n < 60; n++) {
      shownIds.push(
        await createEdge(shownWriter, await createItem(shownWriter), target),
      );
      await createEdge(hiddenWriter, await createItem(hiddenWriter), target);
    }

    const read = await readItem(unfiltered, target, "backrefs");
    expect(read.backrefs?.about?.data).toHaveLength(50);
    expect(read.backrefs?.about?.next_cursor).not.toBeNull();

    const block = (await readItem(filtered, target, "backrefs")).backrefs
      ?.about;
    expect(block?.data).toHaveLength(50);
    const cursor = block?.next_cursor;
    expect(cursor).toBeTruthy();
    const rest = await page(
      filtered,
      `/items/${target}/backrefs?edge_type=about&cursor=${encodeURIComponent(String(cursor))}`,
    );
    expect(rest.next_cursor).toBeNull();
    expect(
      [...(block?.data ?? []), ...rest.data].map((e) => e.id).sort(),
    ).toEqual([...shownIds].sort());
  });
});

describe("a source item with no source", () => {
  it("is judged as the item listing judges it: refused by a filter that covers its type", async () => {
    const orphan = (
      await ctx.storage.runInTransaction(() =>
        itemWrites(ctx.storage).create({
          writer: null,
          type: "core.note",
          properties: { body: "written by the platform" },
        }),
      )
    ).id;
    const target = await createItem(shownWriter);
    const edge = await createEdge(shownWriter, orphan, target);

    // The witness: the item listing hides the item from the filtered key and
    // shows it to one with no filter, and the unfiltered edge listing holds
    // the edge.
    const listed = async (key: string): Promise<string[]> => {
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await request(
          ctx.app,
          "GET",
          `/items?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          { key },
        );
        expect(res.status, await res.clone().text()).toBe(200);
        const body = (await res.json()) as {
          data: { id: string }[];
          next_cursor: string | null;
        };
        found.push(...body.data.map((i) => i.id));
        cursor = body.next_cursor;
      } while (cursor);
      return found;
    };
    expect(await listed(unfiltered)).toContain(orphan);
    expect(await listed(filtered)).not.toContain(orphan);
    expect(await ids(unfiltered, "/edges")).toContain(edge);

    expect(await ids(filtered, "/edges")).not.toContain(edge);
    expect(await ids(filtered, `/items/${target}/backrefs`)).toEqual([]);
    expect(await ids(filtered, `/items/${orphan}/edges`)).toEqual([]);
  });
});

describe("a filter set on the instance", () => {
  it("applies to a key with none of its own, and a key's own filter replaces it", async () => {
    const fromShown = await createItem(shownWriter);
    const fromHidden = await createItem(hiddenWriter);
    const target = await createItem(hiddenWriter);
    const kept = await createEdge(shownWriter, fromShown, target);
    const dropped = await createEdge(hiddenWriter, fromHidden, target);

    const set = await request(ctx.app, "PUT", "/config", {
      key: ctx.workingKey,
      body: {
        enforcement: { source_filter: { types: ["*"], sources: [SHOWN] } },
      },
    });
    expect(set.status, await set.clone().text()).toBe(200);
    try {
      // `unfiltered` has no filter of its own, so the instance's holds for it.
      const inherited = await ids(unfiltered, "/edges");
      expect(inherited).toContain(kept);
      expect(inherited).not.toContain(dropped);

      // The witness: a key whose own filter admits the hidden source still
      // sees the edge, so the instance's filter is not on every reader.
      const own = await mintKey("admits-hidden", `own-${tag}`, {
        types: ["*"],
        sources: [HIDDEN],
      });
      const replaced = await ids(own, "/edges");
      expect(replaced).toContain(dropped);
      expect(replaced).not.toContain(kept);
    } finally {
      const cleared = await request(ctx.app, "PUT", "/config", {
        key: ctx.workingKey,
        body: {},
      });
      expect(cleared.status).toBe(200);
    }
  });
});
