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
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
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
  await ctx.cleanup();
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
