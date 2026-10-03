import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
const spellings = [
  "1000000000000000100",
  "-1000000000000000100",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "-9007199254740993",
  "9223372036854775807",
  "-9223372036854775808",
  "1e18",
  "-1.25e-7",
  "0.125",
  "-0",
  "0",
];
const rows: { id: string; value: number }[] = [];
const otherIds: string[] = [];
let textId = "";
let missingId = "";
let nullId = "";

beforeAll(async () => {
  ({ client, ctx } = await createTestContext(
    "compliance",
    "numeric-property-filters",
  ));
  for (const spelling of spellings) {
    const value = Number(spelling);
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: ctx.runId, numeric_probe: value },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    expect(made.data.item.properties.numeric_probe === value).toBe(true);
    rows.push({ id: made.data.item.id, value });
  }
  for (const [label, value] of [
    ["numeric-text", "0"],
    ["text", "not a number"],
    ["array", []],
    ["object", {}],
    ["null", null],
    ["missing", undefined],
  ] as const) {
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        body: ctx.runId,
        ...(value === undefined ? {} : { other_probe: value }),
      },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    otherIds.push(made.data.item.id);
    if (label === "numeric-text") textId = made.data.item.id;
    if (label === "missing") missingId = made.data.item.id;
    if (label === "null") nullId = made.data.item.id;
  }
});
afterAll(async () => {
  await cleanup(ctx);
});

async function ids(
  door: "items" | "search",
  filter?: string,
): Promise<string[]> {
  const query = new URLSearchParams({ limit: "100" });
  query.set(
    "filter",
    `source eq "${ctx.source}"${filter ? ` AND ${filter}` : ""}`,
  );
  if (door === "search") query.set("q", ctx.runId);
  const result = await client.rawRequest<{
    data: ({ id: string } | { item: { id: string } })[];
  }>(`/${door}?${query.toString()}`);
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.data.data
    .map((row) => ("item" in row ? row.item.id : row.id))
    .sort();
}

const comparisons = {
  eq: (actual: number, bound: number) => actual === bound,
  neq: (actual: number, bound: number) => actual !== bound,
  gt: (actual: number, bound: number) => actual > bound,
  gte: (actual: number, bound: number) => actual >= bound,
  lt: (actual: number, bound: number) => actual < bound,
  lte: (actual: number, bound: number) => actual <= bound,
};

describe("numeric property filters", () => {
  it("witnesses every seeded row on both doors before filtering", async () => {
    const all = [...rows.map((row) => row.id), ...otherIds].sort();
    expect(await ids("items")).toEqual(all);
    expect(await ids("search")).toEqual(all);
  });

  it("compares numeric properties as finite doubles on the listing and search", async () => {
    for (const spelling of spellings) {
      const bound = Number(spelling);
      for (const [op, compare] of Object.entries(comparisons)) {
        const expected = rows
          .filter((row) => compare(row.value, bound))
          .map((row) => row.id)
          .sort();
        for (const door of ["items", "search"] as const) {
          expect(
            await ids(
              door,
              `properties.numeric_probe ${op} ${spelling.replace("1e18", "1000000000000000000").replace("-1.25e-7", "-0.000000125")}`,
            ),
            `${door}: ${op} ${spelling}`,
          ).toEqual(expected);
        }
      }
    }
  });

  it("does not turn text, arrays, objects, missing or null properties into numeric equality matches", async () => {
    for (const door of ["items", "search"] as const) {
      expect(await ids(door, 'properties.other_probe eq "0"')).toEqual([
        textId,
      ]);
      expect(await ids(door, "properties.other_probe eq 0")).toEqual([]);
      expect(await ids(door, "properties.other_probe neq 0")).toEqual(
        otherIds.filter((id) => id !== missingId && id !== nullId).sort(),
      );
    }
  });
});
