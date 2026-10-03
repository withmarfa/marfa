import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext;
const token = "numericpropertyfilterprobe";
const values = [
  1000000000000000100, -1000000000000000100, 9007199254740992, 1e18, 0.125,
  -1.25e-7, 0,
];
const rows: { id: string; value: number }[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  for (const value of values) {
    const made = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: token, numeric_probe: value },
      },
    });
    expect(made.status).toBe(201);
    const { item } = (await made.json()) as {
      item: { id: string; properties: { numeric_probe: number } };
    };
    expect(item.properties.numeric_probe).toBe(value);
    rows.push({ id: item.id, value: item.properties.numeric_probe });
  }
});
afterAll(async () => {
  await ctx.cleanup();
});

const comparisons = {
  eq: (actual: number, bound: number) => actual === bound,
  neq: (actual: number, bound: number) => actual !== bound,
  gt: (actual: number, bound: number) => actual > bound,
  gte: (actual: number, bound: number) => actual >= bound,
  lt: (actual: number, bound: number) => actual < bound,
  lte: (actual: number, bound: number) => actual <= bound,
};

for (const door of ["items", "search"] as const) {
  describe(`${door} numeric property filters`, () => {
    it.each(Object.entries(comparisons))(
      "answers %s over the numbers it returned",
      async (op, compare) => {
        for (const value of values) {
          const query = new URLSearchParams({
            filter: `properties.numeric_probe ${op} ${value === -1.25e-7 ? "-0.000000125" : String(value)}`,
            limit: "100",
          });
          if (door === "search") query.set("q", token);
          const res = await request(
            ctx.app,
            "GET",
            `/${door}?${query.toString()}`,
            { key: ctx.workingKey },
          );
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            data: ({ id: string } | { item: { id: string } })[];
          };
          const ids = body.data
            .map((row) => ("item" in row ? row.item.id : row.id))
            .sort();
          expect(
            ids,
            `${op} ${value === -1.25e-7 ? "-0.000000125" : String(value)}`,
          ).toEqual(
            rows
              .filter((row) => compare(row.value, value))
              .map((row) => row.id)
              .sort(),
          );
        }
      },
    );
  });
}
