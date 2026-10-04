/**
 * Read from the query plan, not reasoning. A sweep asks for one page after
 * another, so a plan that sorts or groups in a temporary tree reads everything
 * after the cursor for every page and makes the sweep quadratic.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { SqliteVersionStore } from "./sqlite/version-store.js";
import { SCHEMA_SQL } from "./sqlite/connection.js";

describe("the thinning candidate query plan", () => {
  it.each([undefined, "01a1082b-dce6-7720-b63f-3c43272fb4de"])(
    "walks the item id index in order with no temporary tree (after: %s)",
    async (after) => {
      const client = createClient({ url: ":memory:" });
      try {
        await client.executeMultiple(SCHEMA_SQL);
        const captured: { sql: string; params: unknown[] }[] = [];
        const db = drizzleSqlite(client, {
          logger: {
            logQuery(sql: string, params: unknown[]) {
              captured.push({ sql, params });
            },
          },
        });
        await new SqliteVersionStore(db as never).listThinningCandidates(
          2,
          100,
          after,
        );
        const query = captured.at(-1);
        expect(query).toBeDefined();
        const plan = (
          await client.execute(
            `EXPLAIN QUERY PLAN ${query!.sql}`,
            query!.params as never[],
          )
        ).rows
          .map((row) => String((row as Record<string, unknown>).detail))
          .join("\n");
        expect(plan).toContain("USING COVERING INDEX idx_versions_item_id");
        expect(plan).not.toContain("TEMP B-TREE");
      } finally {
        client.close();
      }
    },
  );
});
