import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { TestContext } from "../../client/types.js";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { ListFilters, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * The fields a working copy writes and queries, against a real server and the
 * real binary: each answer the device gives is compared with the server's own
 * for the same question (`device/list-source`, `device/list-updated-range`,
 * `device/search-tier`, `device/search-own-time`, `device/sort-property`), and
 * a draft carrying a state, a capture location and edges is drained to the
 * server (`device/create-fields-one-write`, `device/create-edges-replaced`,
 * `device/create-edges-kept-short`, `device/create-edges-read-rest`,
 * `device/edge-write-waits-projected`, `device/create-edges-unread-refused` and
 * `device/create-edges-refused-whole`).
 */

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let store: ReturnType<typeof newStore>;
let otherSource: string;
let apiUrl: string;

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

/** A run of items this file made, found by the one property they share. */
function ours(extra?: string): string {
  const own = `properties.run eq "${ctx.runId}"`;
  return extra ? `${own} AND ${extra}` : own;
}

async function make(
  fields: Record<string, unknown> & { properties?: Record<string, unknown> },
  by: MarfaClient = client,
): Promise<{ id: string; occurred_at: string; updated_at: string }> {
  const { properties, ...rest } = fields;
  const made = await by.createItem({
    type: "core.note",
    tier: "library",
    ...rest,
    properties: { run: ctx.runId, body: ctx.runId, ...properties },
  } as Parameters<MarfaClient["createItem"]>[0]);
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  const item = made.data.item;
  return {
    id: item.id,
    occurred_at: item.occurred_at ?? item.created_at ?? "",
    updated_at: item.updated_at ?? "",
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

const dated: { id: string; at: string; updated: string }[] = [];
let fed: string;
let foreign: string;
beforeAll(async () => {
  const context = await createTestContext("device", "item-fields");
  ({ client, ctx, apiUrl } = context);
  otherSource = `${ctx.source}-other`;
  // Four library items a day apart, then a feed item, then one under another
  // source; each is written a moment after the one before it, so that no two
  // share a change time.
  for (const day of ["01", "02", "03", "04"]) {
    const row = await make({ occurred_at: `2026-03-${day}T00:00:00.000Z` });
    dated.push({ id: row.id, at: row.occurred_at, updated: row.updated_at });
    await pause();
  }
  fed = (await make({ tier: "feed", occurred_at: "2026-03-05T00:00:00.000Z" }))
    .id;
  await pause();
  foreign = (await make({}, await createSecondClient(ctx, "other"))).id;
  expect(new Set(dated.map((row) => row.updated)).size).toBe(4);
  store = newStore("item-fields");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(await device.hydrate(["core.note"], "all"));
});
afterAll(async () => {
  if (store) rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

/** Both answers to one list, in the order each gave them. */
async function listed(filters: ListFilters, extra?: string) {
  const { updatedAfter, updatedBefore, occurredAfter, occurredBefore } =
    filters;
  const served = await client.listItems({
    filter: ours(extra),
    state: "any",
    tier: "all",
    limit: 100,
    ...(filters.source ? { source: filters.source } : {}),
    ...(updatedAfter ? { updated_after: updatedAfter } : {}),
    ...(updatedBefore ? { updated_before: updatedBefore } : {}),
    ...(occurredAfter ? { occurred_after: occurredAfter } : {}),
    ...(occurredBefore ? { occurred_before: occurredBefore } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  });
  expect(served.ok, JSON.stringify(served.error)).toBe(true);
  const local = value(
    await device.list({
      allStates: true,
      limit: 100,
      ...filters,
      filter: ours(extra),
    }),
  );
  return {
    served: served.data.data.map((row) => row.id),
    local: local.map((row) => row.id),
  };
}

it("lists by source as the server does", async () => {
  const other = await listed({ source: otherSource });
  expect(other.served).toEqual([foreign]);
  expect(other.local).toEqual(other.served);
  const own = await listed({ source: ctx.source });
  // The witness: the foreign item is held, and this source leaves it out.
  expect(own.served).not.toContain(foreign);
  expect(own.served).toHaveLength(5);
  expect(own.local).toEqual(own.served);
});

it("lists by a change-time range as the server does, from either end", async () => {
  const [first, second, third, fourth] = dated;
  const cases: [string, ListFilters, string[]][] = [
    // The lower bound is inclusive and the list then runs oldest change first.
    [
      "after alone",
      { updatedAfter: second.updated },
      [second.id, third.id, fourth.id, fed, foreign],
    ],
    // The upper bound is exclusive; alone, it leaves the default order.
    ["before alone", { updatedBefore: third.updated }, [second.id, first.id]],
    [
      "both",
      { updatedAfter: second.updated, updatedBefore: fourth.updated },
      [second.id, third.id],
    ],
  ];
  for (const [name, filters, expected] of cases) {
    const answers = await listed(filters);
    expect(answers.served, name).toEqual(expected);
    expect(answers.local, name).toEqual(expected);
  }
  // Its own order, named whole or by either half, is taken by both; another
  // order, named by either half, is refused by both.
  const orders: [ListFilters, boolean][] = [
    [{ sort: "updated_at", direction: "asc" }, true],
    [{ sort: "updated_at" }, true],
    [{ direction: "asc" }, true],
    [{ sort: "created_at" }, false],
    [{ direction: "desc" }, false],
  ];
  for (const [order, taken] of orders) {
    const name = JSON.stringify(order);
    const served = await client.listItems({
      filter: ours(),
      updated_after: third.updated,
      ...(order.sort ? { sort: order.sort } : {}),
      ...(order.direction ? { direction: order.direction } : {}),
    });
    expect(served.ok, name).toBe(taken);
    const local = await device.list({
      filter: ours(),
      updatedAfter: third.updated,
      ...order,
    });
    expect(local.ok, name).toBe(taken);
    if (local.ok && served.ok) {
      expect(
        local.value.map((row) => row.id),
        name,
      ).toEqual(served.data.data.map((row) => row.id));
    } else if (!local.ok) {
      expect(local.refusal.raw, name).toContain(
        `(${served.error?.error.code})`,
      );
    }
  }
});

it("narrows a list and a search by a range of own time from either end, leaving both bounds out", async () => {
  const [first, second, third, fourth] = dated;
  const cases: [string, ListFilters, string[]][] = [
    ["after alone", { occurredAfter: second.at }, [fed, fourth.id, third.id]],
    ["before alone", { occurredBefore: third.at }, [second.id, first.id]],
    [
      "both",
      { occurredAfter: first.at, occurredBefore: fourth.at },
      [third.id, second.id],
    ],
  ];
  for (const [name, filters, expected] of cases) {
    const answers = await listed(filters, `source eq "${ctx.source}"`);
    // The foreign item has no own time in March, so no case reaches it.
    expect(answers.served, name).toEqual(expected);
    expect(answers.local, name).toEqual(expected);
    const searched = await client.search(ctx.runId, {
      state: "active",
      tier: "all",
      limit: 100,
      ...(filters.occurredAfter
        ? { occurred_after: filters.occurredAfter }
        : {}),
      ...(filters.occurredBefore
        ? { occurred_before: filters.occurredBefore }
        : {}),
    });
    expect(searched.ok, JSON.stringify(searched.error)).toBe(true);
    const local = value(
      await device.search(
        ctx.runId,
        {
          occurredAfter: filters.occurredAfter,
          occurredBefore: filters.occurredBefore,
        },
        100,
      ),
    );
    const mine = (ids: string[]) => ids.filter((id) => expected.includes(id));
    expect(
      mine(searched.data.data.map((hit) => hit.item.id)).sort(),
      name,
    ).toEqual([...expected].sort());
    expect(mine(local.map((hit) => hit.item.id)).sort(), name).toEqual(
      [...expected].sort(),
    );
  }
});

it("searches by tier as the server does", async () => {
  for (const tier of ["feed", "library"] as const) {
    const served = await client.search(ctx.runId, { tier, limit: 100 });
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
    const local = value(await device.search(ctx.runId, { tier }, 100));
    const ids = (hits: { item: { id: string } }[]) =>
      hits
        .map((hit) => hit.item.id)
        .filter((id) => id === fed || dated.some((row) => row.id === id))
        .sort();
    expect(ids(local), tier).toEqual(ids(served.data.data));
    expect(ids(local).includes(fed), tier).toBe(tier === "feed");
  }
});

it("sorts by a property in the server's order, missing, numeric, text, boolean and tied", async () => {
  const run = `${ctx.runId}-sorted`;
  const rows: Record<string, Record<string, unknown>> = {
    ten: { n: 10 },
    twoB: { n: 2 },
    twoA: { n: 2 },
    half: { n: 0.5 },
    yes: { n: true },
    no: { n: false },
    beta: { n: "beta" },
    alpha: { n: "alpha" },
    none: {},
    list: { n: [1] },
    object: { n: { a: 1 } },
  };
  const ids = new Map<string, string>();
  for (const [name, properties] of Object.entries(rows)) {
    const row = await make({ properties: { ...properties, sorted: run } });
    ids.set(row.id, name);
  }
  value(await device.catchUp());
  for (const direction of ["asc", "desc"] as const) {
    const filter = `properties.sorted eq "${run}"`;
    const served = await client.listItems({
      filter,
      sort: "properties.n",
      direction,
      limit: 100,
    });
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
    const local = value(
      await device.list({
        filter,
        sort: "properties.n",
        direction,
        limit: 100,
      }),
    );
    const names = (list: { id: string }[]) =>
      list.map((row) => ids.get(row.id));
    expect(names(local), direction).toEqual(names(served.data.data));
    // The witness: numbers and booleans, then text, then the rest last in
    // either direction, with equal values by id.
    const order = names(served.data.data);
    expect(order.slice(-3).sort(), direction).toEqual(
      ["list", "none", "object"].sort(),
    );
    expect(order.indexOf("alpha") < order.indexOf("beta"), direction).toBe(
      direction === "asc",
    );
  }
});

it("refuses a property sort the server's grammar refuses", async () => {
  const served = await client.listItems({
    sort: "properties.Bad-Name" as `properties.${string}`,
  });
  expect(served.ok).toBe(false);
  const local = await device.list({
    sort: "properties.Bad-Name" as `properties.${string}`,
  });
  expect(local.ok).toBe(false);
});

it("drains a draft carrying a state, a capture location and edges as one write", async () => {
  const targets = [await make({}), await make({})].map((row) => row.id);
  value(await device.catchUp());
  const queued = value(
    await device.create({
      type: "core.note",
      properties: { run: ctx.runId, body: ctx.runId },
      state: "archived",
      captureLatitude: 51.5,
      captureLongitude: -0.25,
      edges: { references: targets },
    }),
  );
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  expect(value(await device.queue())).toHaveLength(1);

  // Before the server has answered, the copy already shows all three.
  const waiting = value(await device.get(id));
  expect(waiting.state).toBe("archived");
  expect([waiting.capture_latitude, waiting.capture_longitude]).toEqual([
    51.5, -0.25,
  ]);
  const drawn = value(await device.edgesFrom(id));
  expect(drawn.map((edge) => edge.target_id).sort()).toEqual(
    [...targets].sort(),
  );

  expect(
    value(await device.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted"]);
  const served = await client.getItem(id);
  expect(served.ok, JSON.stringify(served.error)).toBe(true);
  expect(served.data.item.state).toBe("archived");
  expect([
    served.data.item.capture_latitude,
    served.data.item.capture_longitude,
  ]).toEqual([51.5, -0.25]);
  const edges = await client.listItemEdges(id, { edge_type: "references" });
  expect(edges.ok, JSON.stringify(edges.error)).toBe(true);
  const serverEdges = edges.data.data.map((edge) => edge.id).sort();
  expect(serverEdges).toHaveLength(2);

  // After, the copy holds the server's edges and not the ones it drew.
  const held = value(await device.edgesFrom(id));
  expect(held.map((edge) => edge.id).sort()).toEqual(serverEdges);
  const read = value(await device.get(id));
  expect([read.state, read.capture_latitude, read.capture_longitude]).toEqual([
    "archived",
    51.5,
    -0.25,
  ]);
});

/** Every edge of `type` the server holds from `id`, walked to the end. */
async function servedEdges(id: string, type: string) {
  const all: { id: string; target_id: string; version: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listItemEdges(id, {
      edge_type: type,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    all.push(...page.data.data);
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

/**
 * A created item drawn to sixty targets, drained: more than the fifty an
 * item's answer carries inline for one edge type, so the answer's block is
 * cut and names a cursor for the rest.
 */
async function drainedWithSixtyEdges(body: string) {
  const targets: string[] = [];
  for (let n = 0; n < 60; n++) targets.push((await make({})).id);
  value(await device.catchUp());
  const queued = value(
    await device.create({
      type: "core.note",
      properties: { run: ctx.runId, body },
      edges: { references: targets },
    }),
  );
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  expect(
    value(await device.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted"]);
  const served = await servedEdges(id, "references");
  expect(served).toHaveLength(60);
  // The targets a read of the item leaves out of its block, as the create's
  // answer did.
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  const block = read.data.item.edges?.references;
  expect(block?.data).toHaveLength(50);
  expect(block?.next_cursor).toBeTruthy();
  const inline = new Set(block?.data.map((edge) => edge.target_id));
  const cut = targets.filter((target) => !inline.has(target));
  expect(cut).toHaveLength(10);
  return { id, targets, served, cut };
}

it("reads the rest of a create's edges the answer cuts off, before the drain returns", async () => {
  const { id, targets, served } = await drainedWithSixtyEdges("many edges");
  // Every target shows one edge, and each is the server's own: the ten the
  // answer left out were read while the create settled.
  const shown = value(await device.edgesFrom(id));
  expect(shown.map((edge) => edge.target_id).sort()).toEqual(
    [...targets].sort(),
  );
  expect(shown.map((edge) => edge.id).sort()).toEqual(
    served.map((edge) => edge.id).sort(),
  );
});

it("sends a delete of an edge the create's answer cut off to the server's edge", async () => {
  const { id, served, cut } = await drainedWithSixtyEdges("delete one");
  const gone = cut[4];
  const edge = value(await device.edgesFrom(id)).find(
    (row) => row.target_id === gone,
  );
  // The witness: the server holds an edge to the target before the delete.
  expect(served.map((row) => row.target_id)).toContain(gone);
  value(await device.deleteEdge(edge?.id ?? ""));
  expect(
    value(await device.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted"]);
  const after = await servedEdges(id, "references");
  expect(after).toHaveLength(59);
  expect(after.map((row) => row.target_id)).not.toContain(gone);
  // The delete stays done on the device too.
  value(await device.catchUp());
  const shown = value(await device.edgesFrom(id));
  expect(shown.map((row) => row.target_id)).not.toContain(gone);
  expect(shown.map((row) => row.id).sort()).toEqual(
    after.map((row) => row.id).sort(),
  );
});

it("sends an edit of an edge the create's answer cut off to the server's edge", async () => {
  const { id, cut } = await drainedWithSixtyEdges("edit one");
  const edited = cut[4];
  const edge = value(await device.edgesFrom(id)).find(
    (row) => row.target_id === edited,
  );
  value(
    await device.updateEdge(edge?.id ?? "", {
      properties: { note: "edited" },
      version: edge?.version,
    }),
  );
  expect(
    value(await device.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted"]);
  const after = await servedEdges(id, "references");
  expect(after).toHaveLength(60);
  const served = after.find((row) => row.target_id === edited);
  expect(served?.id).toBe(edge?.id);
  expect(served?.version).toBe(2);
});

it("refuses a waiting delete of an edge no read of the created item brings, without sending it", async () => {
  const target = (await make({})).id;
  // A key whose source filter leaves out the source it writes under, so the
  // create's answer and every read of the item's edges hold none.
  const filtered = await client.createKey({
    label: `${ctx.source}-unread`,
    source: `${ctx.source}-unread`,
    type_permissions: { "core.note": "write" },
    edge_permissions: { references: "write" },
    enforcement_override: {
      source_filter: { types: ["core.note"], sources: [ctx.source] },
    },
    default_tier: "library",
  });
  expect(filtered.ok, JSON.stringify(filtered.error)).toBe(true);
  trackKey(ctx, filtered.data.id);
  const unreadStore = newStore("item-fields-unread");
  const unread = new CliDevice({
    binary: requireBinary(),
    store: unreadStore,
    url: apiUrl,
    key: filtered.data.key,
  });
  try {
    value(await unread.hydrate(["core.note"], "all"));
    const queued = value(
      await unread.create({
        type: "core.note",
        properties: { run: ctx.runId, body: "unread edges" },
        edges: { references: [target] },
      }),
    );
    const id = queued.item_id ?? "";
    trackItem(ctx, id);
    const [shown] = value(await unread.edgesFrom(id));
    value(await unread.deleteEdge(shown?.id ?? ""));
    const drained = value(await unread.drain());
    expect(
      drained.verdicts.map((verdict) => verdict.verdict),
      JSON.stringify(drained),
    ).toContain("accepted");
    // The witness: the server made the edge, and the delete never reached it.
    const served = await client.listItemEdges(id, { edge_type: "references" });
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
    expect(served.data.data.map((edge) => edge.target_id)).toEqual([target]);
    const write = value(await unread.queue()).find(
      (row) => row.kind === "delete_edge",
    );
    expect(write?.verdict).toBe("refused");
    // Refused on the device: the server never answered it.
    expect(write?.answer, JSON.stringify(write)).toBeNull();
    expect(value(await unread.edgesFrom(id))).toEqual([]);
  } finally {
    rmSync(dirname(unreadStore), { recursive: true, force: true });
  }
});

it("keeps a draft whose edges name a missing item, refused whole, and shows none of it", async () => {
  const [present] = [await make({})].map((row) => row.id);
  value(await device.catchUp());
  const missing = "01900000-0000-7000-8000-000000000001";
  const queued = value(
    await device.create({
      type: "core.note",
      properties: { run: ctx.runId, body: "refused" },
      edges: { references: [present, missing] },
    }),
  );
  const id = queued.item_id ?? "";
  const verdicts = value(await device.drain()).verdicts.map(
    (verdict) => verdict.verdict,
  );
  expect(verdicts).toEqual(["refused"]);
  // The server made neither the item nor the edge to the item that exists.
  const served = await client.getItem(id);
  expect(served.ok).toBe(false);
  const edges = await client.listItemEdges(present);
  expect(edges.ok, JSON.stringify(edges.error)).toBe(true);
  expect(edges.data.data).toEqual([]);
  // What the person made stays in the queue, with its edges; the copy shows
  // neither the item nor an edge drawn for it.
  const write = value(await device.queue()).find((row) => row.item_id === id);
  expect(write?.verdict).toBe("refused");
  expect(JSON.stringify(write?.body)).toContain(missing);
  expect((await device.get(id)).ok).toBe(false);
  expect(value(await device.edgesTo(present))).toEqual([]);
});

it("sets and clears an item's own time through an edit", async () => {
  const row = await make({ occurred_at: "2026-04-01T00:00:00.000Z" });
  const created = (await client.getItem(row.id)).data.item;
  value(await device.catchUp());
  let version = value(await device.get(row.id)).version;

  value(
    await device.update(row.id, {
      properties: {},
      version,
      occurredAt: "2025-06-01T12:00:00.000Z",
    }),
  );
  expect(value(await device.get(row.id)).occurred_at).toBe(
    "2025-06-01T12:00:00.000Z",
  );
  value(await device.drain());
  const set = (await client.getItem(row.id)).data.item;
  expect(set.occurred_at).toBe("2025-06-01T12:00:00.000Z");

  version = value(await device.get(row.id)).version;
  value(
    await device.update(row.id, {
      properties: {},
      version,
      clearOccurredAt: true,
    }),
  );
  // An item with none of its own is placed at its creation time.
  expect(value(await device.get(row.id)).occurred_at).toBe(created.created_at);
  value(await device.drain());
  const cleared = (await client.getItem(row.id)).data.item;
  expect(cleared.occurred_at).toBe(created.created_at);
  expect(value(await device.get(row.id)).occurred_at).toBe(cleared.occurred_at);
});

it("clears the own time of an item whose create still waits to the server's creation time", async () => {
  const queued = value(
    await device.create({
      type: "core.note",
      properties: { run: ctx.runId, body: "cleared while waiting" },
      occurredAt: "2025-06-01T12:00:00.000Z",
    }),
  );
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  // An edit queued behind the create names a time too, and the clear takes
  // both out.
  value(
    await device.update(id, {
      properties: {},
      version: value(await device.get(id)).version,
      occurredAt: "2024-01-01T00:00:00.000Z",
    }),
  );
  value(
    await device.update(id, {
      properties: { body: "edited while waiting" },
      version: value(await device.get(id)).version,
      clearOccurredAt: true,
    }),
  );
  // Sent later than queued, so the server's creation time is its own.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  value(await device.drain());
  const served = (await client.getItem(id)).data.item;
  expect(served.properties.body).toBe("edited while waiting");
  expect(served.occurred_at).toBe(served.created_at);
  expect(value(await device.get(id)).occurred_at).toBe(served.created_at);
});

it("clears the own time of a keyed create that lands on a row the server holds", async () => {
  const key = `cleared-${ctx.runId}`;
  const held = await make({
    source: ctx.source,
    source_id: key,
    occurred_at: "2020-01-01T00:00:00.000Z",
  });
  // The witness: the same landing without the clear keeps the held row's time.
  const kept = await make({
    source: ctx.source,
    source_id: `${key}-kept`,
    occurred_at: "2020-01-01T00:00:00.000Z",
  });
  const draft = (sourceId: string) =>
    device.create({
      type: "core.note",
      source: ctx.source,
      sourceId,
      properties: { run: ctx.runId, body: "queued under a held key" },
    });
  const clearing = value(await draft(key));
  value(
    await device.update(clearing.item_id ?? "", {
      properties: {},
      version: value(await device.get(clearing.item_id ?? "")).version,
      clearOccurredAt: true,
    }),
  );
  value(await draft(`${key}-kept`));
  value(await device.drain());
  const served = (await client.getItem(held.id)).data.item;
  expect(served.properties.body).toBe("queued under a held key");
  expect(served.occurred_at).toBe(served.created_at);
  const witness = (await client.getItem(kept.id)).data.item;
  expect(witness.occurred_at).toBe("2020-01-01T00:00:00.000Z");
  expect(value(await device.get(held.id)).occurred_at).toBe(served.created_at);
});

it("sends the time set after a clear on a keyed create that lands on a held row", async () => {
  const key = `cleared-then-set-${ctx.runId}`;
  const held = await make({
    source: ctx.source,
    source_id: key,
    occurred_at: "2020-01-01T00:00:00.000Z",
  });
  const queued = value(
    await device.create({
      type: "core.note",
      source: ctx.source,
      sourceId: key,
      properties: { run: ctx.runId, body: "cleared, then set" },
    }),
  );
  const id = queued.item_id ?? "";
  for (const change of [
    { clearOccurredAt: true },
    { occurredAt: "2024-01-01T00:00:00.000Z" },
  ]) {
    value(
      await device.update(id, {
        properties: {},
        version: value(await device.get(id)).version,
        ...change,
      }),
    );
  }
  value(await device.drain());
  const served = (await client.getItem(held.id)).data.item;
  expect(served.occurred_at).toBe("2024-01-01T00:00:00.000Z");
});

it("reads a capture location from the copy as the server holds it", async () => {
  const row = await make({ capture_latitude: -33.9, capture_longitude: 151.2 });
  value(await device.catchUp());
  const held = value(await device.get(row.id));
  expect([held.capture_latitude, held.capture_longitude]).toEqual([
    -33.9, 151.2,
  ]);
});

it("refuses a create the server would refuse for its state, location or edges before it is queued", async () => {
  const before = value(await device.queue()).length;
  const valid = "01900000-0000-7000-8000-000000000002";
  const base = { type: "core.note", properties: { body: "refused" } };
  // The device names each refusal by its class and carries the code the
  // server answers the same body with. A command line carries no NaN, so the
  // binary refuses that one as usage, and no server body matches it.
  const refused: [
    Parameters<typeof device.create>[0],
    string,
    Record<string, unknown>?,
  ][] = [
    [
      { ...base, state: "revoked" as never },
      "validation",
      { ...base, state: "revoked" },
    ],
    [{ ...base, captureLatitude: Number.NaN }, "usage"],
    [
      { ...base, edges: { references: ["not-an-id"] } },
      "validation",
      { ...base, edges: { references: ["not-an-id"] } },
    ],
    [
      { ...base, edges: { "": [valid] } },
      "not_found",
      { ...base, edges: { "": [valid] } },
    ],
  ];
  for (const [draft, kind, body] of refused) {
    const name = JSON.stringify(draft);
    const answer = await device.create(draft);
    expect(answer.ok, name).toBe(false);
    if (answer.ok || !body) {
      if (!answer.ok) expect(answer.refusal.code, name).toBe(kind);
      continue;
    }
    expect(answer.refusal.code, name).toBe(kind);
    const served = await client.createItem(
      body as unknown as Parameters<MarfaClient["createItem"]>[0],
    );
    expect(served.ok, name).toBe(false);
    expect(answer.refusal.raw, name).toContain(`(${served.error?.error.code})`);
  }
  // The witness: the same draft with none of those is queued.
  value(await device.create(base));
  expect(value(await device.queue()).length).toBe(before + 1);
});

it("refuses an edit that names an occurred_at and clears it", async () => {
  const row = await make({});
  value(await device.catchUp());
  const version = value(await device.get(row.id)).version;
  const answer = await device.update(row.id, {
    properties: {},
    version,
    occurredAt: "2025-06-01T12:00:00.000Z",
    clearOccurredAt: true,
  });
  expect(answer.ok).toBe(false);
});
