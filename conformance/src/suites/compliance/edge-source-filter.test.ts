import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaEdge, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let edgeType: string;

/** Writers, each under a source of its own, and the readers that look at what they wrote. */
let shownWriter: MarfaClient;
let alsoShownWriter: MarfaClient;
let hiddenWriter: MarfaClient;
let unfiltered: MarfaClient;
let filtered: MarfaClient;
let filteredTwo: MarfaClient;

let shownSource: string;
let alsoShownSource: string;
let hiddenSource: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-source-filter",
  ));
  shownSource = `${ctx.source}-shown`;
  alsoShownSource = `${ctx.source}-also-shown`;
  hiddenSource = `${ctx.source}-hidden`;

  // Every edge below has this type, so a listing of every edge on a dataset
  // that other files write to still holds only this file's.
  edgeType = `mock.sourcefilter.${ctx.runId}`;
  const registered = await client.registerEdgeType({
    id: edgeType,
    cardinality: "many-to-many",
  });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  trackEdgeType(ctx, edgeType);

  shownWriter = await mintKey("shown-writer", shownSource);
  alsoShownWriter = await mintKey("also-shown-writer", alsoShownSource);
  hiddenWriter = await mintKey("hidden-writer", hiddenSource);
  unfiltered = await mintKey("unfiltered", `${ctx.source}-unfiltered`);
  filtered = await mintKey("filtered", `${ctx.source}-filtered`, {
    types: ["core.note"],
    sources: [shownSource],
  });
  filteredTwo = await mintKey("filtered-two", `${ctx.source}-filtered-two`, {
    types: ["core.note"],
    sources: [shownSource, alsoShownSource],
  });
});

afterAll(async () => {
  await cleanup(ctx);
});

async function mintKey(
  label: string,
  source: string,
  filter?: { types: string[]; sources: string[] },
): Promise<MarfaClient> {
  const minted = await client.createKey({
    label: `edge-source-filter-${label}`,
    source,
    permissions: [],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    ...(filter ? { enforcement_override: { source_filter: filter } } : {}),
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

async function note(writer: MarfaClient): Promise<string> {
  const r = await writer.createItem({
    type: "core.note",
    properties: { body: `edge-source-filter ${ctx.runId}` },
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function edge(
  writer: MarfaClient,
  source: string,
  target: string,
): Promise<string> {
  const r = await writer.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge.id;
}

type Listing = (
  reader: MarfaClient,
  opts?: { limit?: number; cursor?: string },
) => ReturnType<MarfaClient["listEdges"]>;

/** The ids of one whole listing, in order, however many pages it takes. */
async function walk(
  list: Listing,
  reader: MarfaClient,
  limit = 500,
): Promise<{ ids: string[]; sizes: number[] }> {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  do {
    const r = await list(reader, { limit, cursor });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    sizes.push(r.data.data.length);
    ids.push(...r.data.data.map((e: MarfaEdge) => e.id));
    cursor = r.data.next_cursor ?? undefined;
  } while (cursor);
  return { ids, sizes };
}

const sorted = (ids: string[]): string[] => [...ids].sort();

/** Every edge of this file, by type. */
const allEdges: Listing = (reader, opts) =>
  reader.listEdges({ edge_type: edgeType, ...opts });

describe("the source filter on the edge listings", () => {
  it("decides an edge on GET /edges by the source of its source item, whatever the source of its target", async () => {
    const fromShown = await note(shownWriter);
    const fromHidden = await note(hiddenWriter);
    const toShown = await note(shownWriter);
    const toHidden = await note(hiddenWriter);
    const shownToShown = await edge(shownWriter, fromShown, toShown);
    const shownToHidden = await edge(shownWriter, fromShown, toHidden);
    const hiddenToShown = await edge(hiddenWriter, fromHidden, toShown);
    const hiddenToHidden = await edge(hiddenWriter, fromHidden, toHidden);

    // The witness: a key with no filter is handed all four.
    const everything = (await walk(allEdges, unfiltered)).ids;
    for (const id of [
      shownToShown,
      shownToHidden,
      hiddenToShown,
      hiddenToHidden,
    ]) {
      expect(everything).toContain(id);
    }

    const narrowed = (await walk(allEdges, filtered)).ids;
    expect(narrowed).toContain(shownToShown);
    expect(narrowed).toContain(shownToHidden);
    expect(narrowed).not.toContain(hiddenToShown);
    expect(narrowed).not.toContain(hiddenToHidden);
  });

  it("decides an edge on GET /items/{id}/edges by the source of its source item, whatever the source of its target", async () => {
    const anchorShown = await note(shownWriter);
    const anchorHidden = await note(hiddenWriter);
    const target = await note(hiddenWriter);
    const fromShown = await edge(shownWriter, anchorShown, target);
    const fromHidden = await edge(hiddenWriter, anchorHidden, target);

    const itemEdges =
      (anchor: string): Listing =>
      (reader, opts) =>
        reader.listItemEdges(anchor, { edge_type: edgeType, ...opts });

    // The witness: with no filter each anchor lists its edge.
    expect((await walk(itemEdges(anchorShown), unfiltered)).ids).toEqual([
      fromShown,
    ]);
    expect((await walk(itemEdges(anchorHidden), unfiltered)).ids).toEqual([
      fromHidden,
    ]);

    expect((await walk(itemEdges(anchorShown), filtered)).ids).toEqual([
      fromShown,
    ]);
    // The anchor itself reads by id, which the filter does not narrow, and
    // the edges it holds are all ones the filter leaves out.
    expect((await filtered.getItem(anchorHidden)).status).toBe(200);
    expect((await walk(itemEdges(anchorHidden), filtered)).ids).toEqual([]);
  });

  it("decides an edge on GET /items/{id}/backrefs by the source of its source item, whatever the source of its target", async () => {
    const targetShown = await note(shownWriter);
    const targetHidden = await note(hiddenWriter);
    const fromShown = await note(shownWriter);
    const fromHidden = await note(hiddenWriter);
    const shownToHidden = await edge(shownWriter, fromShown, targetHidden);
    const hiddenToHidden = await edge(hiddenWriter, fromHidden, targetHidden);
    const shownToShown = await edge(shownWriter, fromShown, targetShown);
    const hiddenToShown = await edge(hiddenWriter, fromHidden, targetShown);

    const backrefs =
      (anchor: string): Listing =>
      (reader, opts) =>
        reader.listItemBackrefs(anchor, { edge_type: edgeType, ...opts });

    // The witness: with no filter each target lists both of its inbound edges.
    expect(
      sorted((await walk(backrefs(targetHidden), unfiltered)).ids),
    ).toEqual(sorted([shownToHidden, hiddenToHidden]));
    expect(sorted((await walk(backrefs(targetShown), unfiltered)).ids)).toEqual(
      sorted([shownToShown, hiddenToShown]),
    );

    // The target's own source does not enter into it, in either direction.
    expect((await walk(backrefs(targetHidden), filtered)).ids).toEqual([
      shownToHidden,
    ]);
    expect((await walk(backrefs(targetShown), filtered)).ids).toEqual([
      shownToShown,
    ]);
  });

  it("lists an edge on every listing while its source item is in the bin, by that item's source", async () => {
    const binnedShown = await note(shownWriter);
    const binnedHidden = await note(hiddenWriter);
    const target = await note(hiddenWriter);
    const keptEdge = await edge(shownWriter, binnedShown, target);
    const droppedEdge = await edge(hiddenWriter, binnedHidden, target);
    expect((await shownWriter.deleteItem(binnedShown)).ok).toBe(true);
    expect((await hiddenWriter.deleteItem(binnedHidden)).ok).toBe(true);

    const backrefs: Listing = (reader, opts) =>
      reader.listItemBackrefs(target, { edge_type: edgeType, ...opts });

    // The witness: the bin hides neither edge from a key with no filter.
    const everything = (await walk(allEdges, unfiltered)).ids;
    expect(everything).toContain(keptEdge);
    expect(everything).toContain(droppedEdge);
    expect(sorted((await walk(backrefs, unfiltered)).ids)).toEqual(
      sorted([keptEdge, droppedEdge]),
    );

    const narrowed = (await walk(allEdges, filtered)).ids;
    expect(narrowed).toContain(keptEdge);
    expect(narrowed).not.toContain(droppedEdge);
    expect((await walk(backrefs, filtered)).ids).toEqual([keptEdge]);
    expect(
      (
        await walk(
          (reader, opts) =>
            reader.listItemEdges(binnedShown, { edge_type: edgeType, ...opts }),
          filtered,
        )
      ).ids,
    ).toEqual([keptEdge]);
    expect(
      (
        await walk(
          (reader, opts) =>
            reader.listItemEdges(binnedHidden, {
              edge_type: edgeType,
              ...opts,
            }),
          filtered,
        )
      ).ids,
    ).toEqual([]);
  });

  it("lists the edges of every source a filter names that names several, and no other", async () => {
    const fromShown = await note(shownWriter);
    const fromAlsoShown = await note(alsoShownWriter);
    const fromHidden = await note(hiddenWriter);
    const target = await note(hiddenWriter);
    const a = await edge(shownWriter, fromShown, target);
    const b = await edge(alsoShownWriter, fromAlsoShown, target);
    const c = await edge(hiddenWriter, fromHidden, target);

    // The witness: a filter naming one of the two sources leaves the other out.
    const one = (await walk(allEdges, filtered)).ids;
    expect(one).toContain(a);
    expect(one).not.toContain(b);

    const two = (await walk(allEdges, filteredTwo)).ids;
    expect(two).toContain(a);
    expect(two).toContain(b);
    expect(two).not.toContain(c);

    const backrefs: Listing = (reader, opts) =>
      reader.listItemBackrefs(target, { edge_type: edgeType, ...opts });
    expect(sorted((await walk(backrefs, filteredTwo)).ids)).toEqual(
      sorted([a, b]),
    );
  });

  it("fills each page of every listing with the edges the filter shows, and pages to the end", async () => {
    const target = await note(hiddenWriter);
    const anchor = await note(shownWriter);
    const shownIds: string[] = [];
    const outbound: string[] = [];
    // Created alternately, so each listing alternates a shown edge and a
    // hidden one, and a page cut before the filter would be half empty.
    for (let n = 0; n < 8; n++) {
      shownIds.push(await edge(shownWriter, await note(shownWriter), target));
      await edge(hiddenWriter, await note(hiddenWriter), target);
      outbound.push(await edge(shownWriter, anchor, await note(hiddenWriter)));
    }

    const backrefs: Listing = (reader, opts) =>
      reader.listItemBackrefs(target, { edge_type: edgeType, ...opts });
    const itemEdges: Listing = (reader, opts) =>
      reader.listItemEdges(anchor, { edge_type: edgeType, ...opts });

    // The witness: with no filter the backrefs page in full and hold both
    // kinds, so the short pages below are the filter's doing.
    const whole = await walk(backrefs, unfiltered, 4);
    expect(whole.ids).toHaveLength(16);

    const everyEdge = await walk(allEdges, filtered, 4);
    expect(everyEdge.sizes.slice(0, -1).every((size) => size === 4)).toBe(true);
    expect(everyEdge.ids.filter((id) => shownIds.includes(id))).toHaveLength(8);
    expect(everyEdge.ids.filter((id) => outbound.includes(id))).toHaveLength(8);

    const inbound = await walk(backrefs, filtered, 4);
    expect(inbound.sizes).toEqual([4, 4]);
    expect(sorted(inbound.ids)).toEqual(sorted(shownIds));

    const fromAnchor = await walk(itemEdges, filtered, 3);
    expect(fromAnchor.sizes).toEqual([3, 3, 2]);
    expect(sorted(fromAnchor.ids)).toEqual(sorted(outbound));
  });

  it("answers an edge by id whose source item the filter hides", async () => {
    const source = await note(hiddenWriter);
    const target = await note(shownWriter);
    const hiddenEdge = await edge(hiddenWriter, source, target);

    // The witness: the listing leaves the edge out for the same key.
    expect((await walk(allEdges, filtered)).ids).not.toContain(hiddenEdge);

    const read = await filtered.getEdge(hiddenEdge);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(read.data.edge.id).toBe(hiddenEdge);
  });
});

describe("the source filter on the edges an item read carries", () => {
  const about = (
    blocks: Record<string, { data: MarfaEdge[] }> | undefined,
  ): string[] => (blocks?.[edgeType]?.data ?? []).map((e) => e.id).sort();

  it("leaves an edge out of the inbound block of an item read when the filter hides its source item, whatever the source of its target", async () => {
    const target = await note(shownWriter);
    const shownFrom = await note(shownWriter);
    const hiddenFrom = await note(hiddenWriter);
    const fromShown = await edge(shownWriter, shownFrom, target);
    const fromHidden = await edge(hiddenWriter, hiddenFrom, target);

    // The witness: with no filter the block and the neighbors hold both.
    const whole = await unfiltered.getItemIncluding(target, [
      "backrefs",
      "neighbors",
    ]);
    expect(about(whole.data.backrefs)).toEqual(sorted([fromShown, fromHidden]));
    expect(whole.data.neighbors?.map((n) => n.item.id).sort()).toEqual(
      sorted([shownFrom, hiddenFrom]),
    );

    const narrowed = await filtered.getItemIncluding(target, [
      "backrefs",
      "neighbors",
    ]);
    expect(about(narrowed.data.backrefs)).toEqual([fromShown]);
    expect(narrowed.data.neighbors?.map((n) => n.item.id)).toEqual([shownFrom]);
  });

  it("removes an inbound block whose every edge the filter hides", async () => {
    const target = await note(shownWriter);
    await edge(hiddenWriter, await note(hiddenWriter), target);

    const whole = await unfiltered.getItemIncluding(target, ["backrefs"]);
    expect(Object.keys(whole.data.backrefs ?? {})).toEqual([edgeType]);
    const narrowed = await filtered.getItemIncluding(target, ["backrefs"]);
    expect(narrowed.data.backrefs ?? {}).toEqual({});
  });

  it("judges the outbound edges of an item read by the source of that item, whatever the source of their targets", async () => {
    const shown = await note(shownWriter);
    const hidden = await note(hiddenWriter);
    const hiddenTarget = await note(hiddenWriter);
    const shownEdge = await edge(shownWriter, shown, hiddenTarget);
    const hiddenEdge = await edge(hiddenWriter, hidden, hiddenTarget);

    // The witness: with no filter each item carries its edge.
    expect(
      about((await unfiltered.getItemIncluding(hidden, [])).data.item.edges),
    ).toEqual([hiddenEdge]);

    expect(
      about((await filtered.getItemIncluding(shown, [])).data.item.edges),
    ).toEqual([shownEdge]);
    // The item is read by id, which the filter does not narrow, and carries
    // none of the edges a listing of its edges leaves out.
    const read = await filtered.getItemIncluding(hidden, []);
    expect(read.status).toBe(200);
    expect(about(read.data.item.edges)).toEqual([]);
  });

  it("applies to the edges an item listing and a bulk read by id carry", async () => {
    const shown = await note(shownWriter);
    const hidden = await note(hiddenWriter);
    const target = await note(shownWriter);
    const shownEdge = await edge(shownWriter, shown, target);
    const hiddenEdge = await edge(hiddenWriter, hidden, target);

    const listed = await filtered.listItems({
      include: "edges",
      limit: 100,
    });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.data.find((i) => i.id === hidden)).toBeUndefined();
    expect(about(listed.data.data.find((i) => i.id === shown)?.edges)).toEqual([
      shownEdge,
    ]);

    const bulk = await filtered.bulkGet([shown, hidden], ["edges"]);
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(about(bulk.data.items.find((i) => i.id === shown)?.edges)).toEqual([
      shownEdge,
    ]);
    expect(about(bulk.data.items.find((i) => i.id === hidden)?.edges)).toEqual(
      [],
    );

    // The witness: with no filter the same read carries the hidden item's edge.
    const whole = await unfiltered.bulkGet([hidden], ["edges"]);
    expect(about(whole.data.items[0]?.edges)).toEqual([hiddenEdge]);
  });

  it("applies to the edges a lookup carries", async () => {
    const shown = await note(shownWriter);
    const hidden = await note(hiddenWriter);
    const target = await note(shownWriter);
    const shownEdge = await edge(shownWriter, shown, target);
    const hiddenEdge = await edge(hiddenWriter, hidden, target);

    const found = await filtered.lookupItems({
      type: "core.note",
      ids: [shown, hidden],
      include: ["edges"],
    });
    expect(found.status, JSON.stringify(found.error)).toBe(200);
    expect(about(found.data.data.find((i) => i.id === shown)?.edges)).toEqual([
      shownEdge,
    ]);
    // Read by id, so the item the filter hides is answered, without its edges.
    expect(
      found.data.data.find((i) => i.id === hidden),
      "a lookup by id leaves out an item the filter hides",
    ).toBeDefined();
    expect(about(found.data.data.find((i) => i.id === hidden)?.edges)).toEqual(
      [],
    );

    // The witness: with no filter the same lookup carries the hidden item's edge.
    const whole = await unfiltered.lookupItems({
      type: "core.note",
      ids: [hidden],
      include: ["edges"],
    });
    expect(about(whole.data.data[0]?.edges)).toEqual([hiddenEdge]);
  });

  it("applies to the edges the answer to a create carries", async () => {
    const target = await note(shownWriter);
    const create = async (writer: MarfaClient) => {
      const r = await writer.createItem({
        type: "core.note",
        properties: { body: `with an edge ${ctx.runId}` },
        edges: { [edgeType]: [target] },
      });
      expect(r.status, JSON.stringify(r.error)).toBe(201);
      trackItem(ctx, r.data.item.id);
      return about(r.data.item.edges);
    };

    // The witness: a key with no filter is answered with the edge it made.
    expect(await create(unfiltered)).toHaveLength(1);
    // A filter that admits the key's own source keeps it, so the answer below
    // is the filter's refusal of the new item and not of every create.
    const admitsOwn = await mintKey("admits-own", `${ctx.source}-admits-own`, {
      types: ["core.note"],
      sources: [`${ctx.source}-admits-own`],
    });
    expect(await create(admitsOwn)).toHaveLength(1);
    // `filtered` admits only another source, so the item it creates is hidden
    // from it, and so are the edges the item holds.
    expect(await create(filtered)).toEqual([]);
  });

  it("applies to the edges the answer to a write carries", async () => {
    const source = await note(hiddenWriter);
    const target = await note(shownWriter);
    const hiddenEdge = await edge(hiddenWriter, source, target);

    const patch = async (reader: MarfaClient) => {
      const current = await reader.getItem(source);
      expect(current.status, JSON.stringify(current.error)).toBe(200);
      const r = await reader.updateItem(source, {
        version: current.data.item.version,
        properties: { body: `patched ${String(current.data.item.version)}` },
      });
      expect(r.status, JSON.stringify(r.error)).toBe(200);
      return about(r.data.item.edges);
    };

    // The witness: the same write by a key with no filter answers with the edge.
    expect(await patch(unfiltered)).toEqual([hiddenEdge]);
    expect(await patch(filtered)).toEqual([]);
  });

  it("fills a hydrated block to its cap with the edges the filter shows, and continues it at the listing", async () => {
    const target = await note(shownWriter);
    const shownIds: string[] = [];
    // Alternating, so a block cut before the filter would hold about half.
    for (let n = 0; n < 60; n++) {
      shownIds.push(await edge(shownWriter, await note(shownWriter), target));
      await edge(hiddenWriter, await note(hiddenWriter), target);
    }

    // The witness: with no filter the block is full and has more to give.
    const whole = (await unfiltered.getItemIncluding(target, ["backrefs"])).data
      .backrefs?.[edgeType];
    expect(whole?.data).toHaveLength(50);
    expect(whole?.next_cursor).toBeTruthy();

    const block = (await filtered.getItemIncluding(target, ["backrefs"])).data
      .backrefs?.[edgeType];
    expect(block?.data).toHaveLength(50);
    expect(block?.next_cursor).toBeTruthy();
    const rest = await filtered.listItemBackrefs(target, {
      edge_type: edgeType,
      cursor: block?.next_cursor ?? undefined,
    });
    expect(rest.status, JSON.stringify(rest.error)).toBe(200);
    expect(rest.data.next_cursor).toBeNull();
    expect(
      sorted([...(block?.data ?? []), ...rest.data.data].map((e) => e.id)),
    ).toEqual(sorted(shownIds));
  });
});
