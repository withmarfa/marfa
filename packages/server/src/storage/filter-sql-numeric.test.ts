import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type InValue } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and } from "drizzle-orm";
import { parseFilter } from "@withmarfa/shared";
import { filterToRawSql, filterToSqlConditions } from "./filter-sql.js";
import { items } from "./sqlite/schema.js";

const numbers = [
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
const comparisons = {
  eq: (actual: number, bound: number) => actual === bound,
  neq: (actual: number, bound: number) => actual !== bound,
  gt: (actual: number, bound: number) => actual > bound,
  gte: (actual: number, bound: number) => actual >= bound,
  lt: (actual: number, bound: number) => actual < bound,
  lte: (actual: number, bound: number) => actual <= bound,
};

const client = createClient({ url: ":memory:" });
const db = drizzle(client);

beforeAll(async () => {
  await client.execute(
    "CREATE TABLE items (id TEXT PRIMARY KEY, properties BLOB)",
  );
  for (const [index, spelling] of numbers.entries()) {
    await client.execute({
      sql: "INSERT INTO items VALUES (?, jsonb(?))",
      args: [`n${String(index)}`, `{"value":${spelling}}`],
    });
  }
});
afterAll(() => {
  client.close();
});

async function ids(
  filter: string,
  compiler: "drizzle" | "raw",
): Promise<string[]> {
  const expression = parseFilter(filter);
  if (compiler === "drizzle") {
    return (
      await db
        .select({ id: items.id })
        .from(items)
        .where(and(...filterToSqlConditions(expression, items)))
    )
      .map((row) => row.id)
      .sort();
  }
  const compiled = filterToRawSql(expression, "items");
  const result = await client.execute({
    sql: `SELECT id FROM items WHERE ${compiled.clause}`,
    args: compiled.params as InValue[],
  });
  return result.rows.map((row) => row.id as string).sort();
}

for (const compiler of ["drizzle", "raw"] as const) {
  describe(`${compiler} numeric property comparisons`, () => {
    it.each(Object.entries(comparisons))(
      "executes %s using the API number interpretation",
      async (op, compare) => {
        for (const spelling of numbers) {
          const bound = Number(spelling);
          const expected = numbers
            .flatMap((actual, index) =>
              compare(Number(actual), bound) ? [`n${String(index)}`] : [],
            )
            .sort();
          expect(
            await ids(
              `properties.value ${op} ${spelling.replace("1e18", "1000000000000000000").replace("-1.25e-7", "-0.000000125")}`,
              compiler,
            ),
            `${op} ${spelling}`,
          ).toEqual(expected);
        }
      },
    );

    it("preserves Boolean values under numeric literals and text literal types", async () => {
      for (const [id, json] of [
        ["boolean-true", '{"flag":true}'],
        ["boolean-false", '{"flag":false}'],
        ["numeric-one", '{"flag":1}'],
        ["text-one", '{"flag":"1"}'],
      ]) {
        await client.execute({
          sql: "INSERT OR REPLACE INTO items VALUES (?, jsonb(?))",
          args: [id!, json!],
        });
      }
      expect(await ids("properties.flag eq 1", compiler)).toEqual([
        "boolean-true",
        "numeric-one",
      ]);
      expect(await ids("properties.flag eq 0", compiler)).toEqual([
        "boolean-false",
      ]);
      expect(await ids('properties.flag eq "1"', compiler)).toEqual([
        "text-one",
      ]);
    });

    it("does not turn other JSON types into numeric equality matches", async () => {
      const others = [
        ["numeric-text", '{"other":"0"}'],
        ["text", '{"other":"not a number"}'],
        ["array", '{"other":[]}'],
        ["object", '{"other":{}}'],
        ["null", '{"other":null}'],
        ["missing", "{}"],
      ];
      for (const [id, json] of others) {
        await client.execute({
          sql: "INSERT OR REPLACE INTO items VALUES (?, jsonb(?))",
          args: [id!, json!],
        });
      }
      expect(await ids("properties.other eq 0", compiler)).toEqual([]);
      expect(await ids("properties.other neq 0", compiler)).toEqual([
        "array",
        "numeric-text",
        "object",
        "text",
      ]);
      expect(await ids('properties.other eq "0"', compiler)).toEqual([
        "numeric-text",
      ]);
      expect(await ids('properties.other eq "not a number"', compiler)).toEqual(
        ["text"],
      );
    });
  });
}
