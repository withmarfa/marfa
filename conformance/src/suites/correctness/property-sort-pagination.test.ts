import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
const numeric: MarfaItem[] = [];
const groups: MarfaItem[][] = [];
const tail: MarfaItem[] = [];

async function create(
  type: string,
  properties: Record<string, unknown>,
): Promise<MarfaItem> {
  const response = await client.createItem({
    type,
    source: ctx.source,
    properties: { title: "Property paging", body: "", ...properties },
  });
  expect(response.ok).toBe(true);
  trackItem(ctx, response.data.item.id);
  return response.data.item;
}

beforeAll(async () => {
  ({ client, ctx } = await createTestContext(
    "correctness",
    "property-sort-pagination",
  ));
  for (const page_count of [2, 10, 20, 30, 40, 50]) {
    numeric.push(await create("core.media.book", { page_count }));
  }
  const equivalentValues = [
    [-2],
    [false, 0],
    [true, 1],
    [1.5],
    [2],
    [10, 10],
    [""],
    ["10"],
    ["2"],
    ['a"b'],
    ["z"],
    ["é", "é"],
  ];
  for (const values of equivalentValues) {
    const group: MarfaItem[] = [];
    for (const type of ["core.media.book", "core.note"]) {
      for (const paging_probe of values) {
        const row = await create(type, { paging_probe });
        expect(row.properties.paging_probe).toEqual(paging_probe);
        group.push(row);
      }
    }
    groups.push(group);
  }
  for (const type of ["core.media.book", "core.note"]) {
    for (const paging_probe of [null, undefined, { nested: 1 }, [2, 3]]) {
      const row = await create(
        type,
        paging_probe === undefined ? {} : { paging_probe },
      );
      if (paging_probe !== undefined)
        expect(row.properties.paging_probe).toEqual(paging_probe);
      tail.push(row);
    }
  }
});

afterAll(async () => {
  await cleanup(ctx);
});

async function walk(
  field: string,
  direction: "asc" | "desc",
  type: string | undefined,
  limit: number,
  known: Set<string>,
): Promise<string[]> {
  const delivered: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listItems({
      source: ctx.source,
      type,
      sort: `properties.${field}`,
      direction,
      limit,
      cursor,
    });
    expect(page.ok).toBe(true);
    expect(page.data.data.length).toBeLessThanOrEqual(limit);
    delivered.push(
      ...page.data.data.filter((row) => known.has(row.id)).map((row) => row.id),
    );
    if (page.data.next_cursor === null) break;
    cursor = page.data.next_cursor;
    expect(cursors.has(cursor)).toBe(false);
    cursors.add(cursor);
    expect(cursors.size).toBeLessThan(200);
  } while (cursor);
  return delivered;
}

describe("property-sort pagination", () => {
  it("walks numeric properties whatever the type filter", async () => {
    const ids = numeric.map((row) => row.id);
    for (const type of ["core.media.book", "core.media.*", undefined]) {
      for (const direction of ["asc", "desc"] as const) {
        expect(
          await walk("page_count", direction, type, 2, new Set(ids)),
        ).toEqual(direction === "asc" ? ids : [...ids].reverse());
      }
    }
  });

  it("walks mixed scalar kinds across types, with ascending ID ties and nulls last", async () => {
    for (const type of ["core.media.book", "core.*", undefined]) {
      const matches = (row: MarfaItem) =>
        type !== "core.media.book" || row.type === type;
      const ids = (rows: MarfaItem[]) =>
        rows
          .filter(matches)
          .map((row) => row.id)
          .sort();
      const known = new Set([...groups.flat(), ...tail].map((row) => row.id));
      for (const direction of ["asc", "desc"] as const) {
        const orderedGroups =
          direction === "asc" ? groups : [...groups].reverse();
        const expected = [...orderedGroups.flatMap(ids), ...ids(tail)];
        for (const limit of [1, 2, 3]) {
          expect(
            await walk("paging_probe", direction, type, limit, known),
          ).toEqual(expected);
        }
      }
    }
  });
});
