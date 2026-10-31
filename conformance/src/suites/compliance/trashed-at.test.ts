import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, MarfaItem } from "../../client/types.js";
import {
  createTestContext,
  createSecondClient,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

/**
 * When an item went to the bin, on the item itself (`items/trashed-at`,
 * `items/trashed-at-null`, `items/trashed-at-fresh`), and the bin's own
 * order (`search-and-filters/bin-order`).
 *
 * The rows are created in one order and binned in another, so a listing
 * that still ordered the bin by creation answers a different sequence from
 * one ordered by when each row went there.
 */

let client: MarfaClient;
let ctx: TestContext;

async function seed(label: string): Promise<MarfaItem> {
  const res = await client.createItem(
    createNote({
      source: ctx.source,
      source_id: `trashed-at-${label}`,
      properties: { title: `trashed-at ${label}`, body: label },
    }),
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
  trackItem(ctx, res.data.item.id);
  return res.data.item;
}

/** Bin a row, then wait out the millisecond, so the next row's time differs. */
async function bin(id: string): Promise<void> {
  const res = await client.deleteItem(id);
  expect(res.ok, JSON.stringify(res)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** This file's rows in the bin, in the order the listing returned them. */
async function binned(
  reader: MarfaClient,
  filters: Parameters<MarfaClient["listItems"]>[0] = {},
  mine?: ReadonlySet<string>,
): Promise<MarfaItem[]> {
  const res = await reader.listItems({
    source: ctx.source,
    state: "trashed",
    limit: 100,
    ...filters,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res.data.data.filter(
    (item) => mine === undefined || mine.has(item.id),
  );
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "trashed-at"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("trashed_at on the item", () => {
  it("is null on a live item, never missing", async () => {
    const item = await seed("live");
    expect(item).toHaveProperty("trashed_at", null);
    const read = await client.getItem(item.id);
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.data.item).toHaveProperty("trashed_at", null);
  });

  it("records the time an item went to the bin, to any key that may read it, and clears it on restore", async () => {
    const item = await seed("restore");
    const before = Date.now();
    await bin(item.id);
    const after = Date.now();

    const reader = await createSecondClient(ctx, "trashed-at-reader");
    const [row] = await binned(reader, {}, new Set([item.id]));
    expect(row, "a second key cannot see the binned row").toBeDefined();
    expect(row.trashed_at, "the bin listing carries no trashed_at").not.toBe(
      null,
    );
    const at = Date.parse(row.trashed_at ?? "");
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(after + 1000);

    const restored = await client.restoreItem(item.id);
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    expect(restored.data.item.trashed_at).toBe(null);
    const read = await client.getItem(item.id);
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.data.item.trashed_at).toBe(null);
  });

  it("takes a new time when a restored item goes to the bin again", async () => {
    const item = await seed("again");
    await bin(item.id);
    const [first] = await binned(client, {}, new Set([item.id]));
    expect(first?.trashed_at).not.toBe(null);

    const restored = await client.restoreItem(item.id);
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await bin(item.id);

    const [second] = await binned(client, {}, new Set([item.id]));
    expect(
      Date.parse(second?.trashed_at ?? ""),
      "a second trip to the bin kept the first trip's time",
    ).toBeGreaterThan(Date.parse(first?.trashed_at ?? ""));
  });
});

describe("the order of the bin", () => {
  let order: { first: MarfaItem; second: MarfaItem; third: MarfaItem };
  let mine: Set<string>;

  beforeAll(async () => {
    const first = await seed("order-a");
    const second = await seed("order-b");
    const third = await seed("order-c");
    // Binned b, c, a: newest binned first is a, c, b, while creation order
    // newest first is c, b, a.
    await bin(second.id);
    await bin(third.id);
    await bin(first.id);
    order = { first, second, third };
    mine = new Set([first.id, second.id, third.id]);
  });

  it("lists the bin newest binned first when no sort is named", async () => {
    const ids = (await binned(client, {}, mine)).map((item) => item.id);
    expect(ids).toEqual([order.first.id, order.third.id, order.second.id]);
  });

  it("reverses it with direction=asc", async () => {
    const ids = (await binned(client, { direction: "asc" }, mine)).map(
      (item) => item.id,
    );
    expect(ids).toEqual([order.second.id, order.third.id, order.first.id]);
  });

  it("walks the same order one page at a time", async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await client.listItems({
        source: ctx.source,
        state: "trashed",
        limit: 1,
        ...(cursor !== undefined && { cursor }),
      });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      ids.push(...res.data.data.map((item) => item.id));
      if (res.data.next_cursor === null) break;
      cursor = res.data.next_cursor;
    }
    expect(ids.filter((id) => mine.has(id))).toEqual([
      order.first.id,
      order.third.id,
      order.second.id,
    ]);
  });

  it("still honors a named sort", async () => {
    const ids = (await binned(client, { sort: "created_at" }, mine)).map(
      (item) => item.id,
    );
    expect(ids).toEqual([order.third.id, order.second.id, order.first.id]);
  });

  it("orders a listing of several states by creation", async () => {
    const res = await client.listItems({
      source: ctx.source,
      state: "trashed,archived",
      limit: 100,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const ids = res.data.data
      .map((item) => item.id)
      .filter((id) => mine.has(id));
    expect(ids).toEqual([order.third.id, order.second.id, order.first.id]);
  });
});
