import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and } from "drizzle-orm";
import { parseFilter } from "@withmarfa/shared";
import { filterToSqlConditions } from "./filter-sql.js";
import { items } from "./sqlite/schema.js";

const ROWS: Record<string, string> = {
  second: '{"emails":[{"value":"a@example.com"},{"value":"b@example.com"}]}',
  first: '{"emails":[{"value":"b@example.com","label":"work"}]}',
  other: '{"emails":[{"value":"c@example.com"}]}',
  text: '{"emails":"b@example.com"}',
  object: '{"emails":{"value":"b@example.com"}}',
  objects: '{"emails":{"x":{"value":"b@example.com"}}}',
  scalars: '{"emails":["b@example.com",1,null]}',
  other_member: '{"emails":[{"address":"b@example.com"}]}',
  none: '{"name":"x"}',
  number: '{"ranks":[{"value":5.0},{"value":"5"}]}',
};

const client = createClient({ url: ":memory:" });
const db = drizzle(client);

beforeAll(async () => {
  await client.execute(
    "CREATE TABLE items (id TEXT PRIMARY KEY, properties BLOB)",
  );
  for (const [id, json] of Object.entries(ROWS)) {
    await client.execute({
      sql: "INSERT INTO items VALUES (?, jsonb(?))",
      args: [id, json],
    });
  }
});
afterAll(() => {
  client.close();
});

async function ids(filter: string): Promise<string[]> {
  return (
    await db
      .select({ id: items.id })
      .from(items)
      .where(and(...filterToSqlConditions(parseFilter(filter), items)))
  )
    .map((row) => row.id)
    .sort();
}

describe("a member of a list's entries", () => {
  it("matches a row any of whose entries holds the value, and no row whose field is not a list of objects", async () => {
    expect(await ids('properties.emails.value eq "b@example.com"')).toEqual([
      "first",
      "second",
    ]);
    expect(await ids('properties.emails.label eq "work"')).toEqual(["first"]);
  });

  it("compares a number as a property term does", async () => {
    expect(await ids("properties.ranks.value eq 5")).toEqual(["number"]);
    expect(await ids('properties.ranks.value eq "5"')).toEqual(["number"]);
    expect(await ids("properties.emails.value eq 1")).toEqual([]);
  });
});
