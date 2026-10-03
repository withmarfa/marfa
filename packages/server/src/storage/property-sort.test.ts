import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import {
  buildPropertySortExpr,
  propertySortBound,
  propertySortValue,
} from "./property-sort.js";

const client = createClient({ url: ":memory:" });
const db = drizzle(client);
afterAll(() => {
  client.close();
});

describe("property SQL and cursor scalar agreement", () => {
  it.each([
    { value: -2, expected: -2, kind: "integer" },
    { value: false, expected: 0, kind: "integer" },
    { value: true, expected: 1, kind: "integer" },
    { value: 0.1, expected: 0.1, kind: "real" },
    { value: 1e30, expected: 1e30, kind: "real" },
    { value: 9007199254740991, expected: 9007199254740991, kind: "integer" },
    { value: "", expected: "", kind: "text" },
    { value: "2", expected: "2", kind: "text" },
    { value: 'é " \\ \n', expected: 'é " \\ \n', kind: "text" },
    { value: null, expected: null, kind: "null" },
    { value: undefined, expected: null, kind: "null" },
    { value: { nested: 1 }, expected: null, kind: "null" },
    { value: [2, 3], expected: null, kind: "null" },
  ])(
    "preserves $kind for $value in SQLite and on resume",
    async ({ value, expected, kind }) => {
      const properties = { probe: value };
      const expression = buildPropertySortExpr(
        sql`${JSON.stringify(properties)}`,
        "probe",
      );
      const row = await db.get<{ value: string | number | null; kind: string }>(
        sql`SELECT ${expression} AS value, typeof(${expression}) AS kind`,
      );
      expect(row).toEqual({ value: expected, kind });
      const encoded = propertySortValue(properties, {
        kind: "property",
        field: "probe",
      });
      if (expected === null) {
        expect(encoded).toBeNull();
      } else {
        const bound = propertySortBound(encoded!);
        const compared = await db.get<{ same: number }>(
          sql`SELECT ${expression} = ${bound} AS same`,
        );
        expect(compared.same).toBe(1);
      }
    },
  );
});
