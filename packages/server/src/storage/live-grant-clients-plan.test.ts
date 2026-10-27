/**
 * Read from the query plan, not reasoning. Without `ANALYZE`, SQLite would
 * prefer the state index for `type = ? AND state = 'active'` if no index held
 * both, which walks every active item, and this read runs on every
 * cross-origin request.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { SqliteOauthProviderStore } from "./sqlite/oauth-provider-store.js";
import { SCHEMA_SQL } from "./sqlite/schema-shape.js";

describe("the live grant clients query plan", () => {
  it("finds grants through the type index and each client through its client_id index, scanning no items", async () => {
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
      await new SqliteOauthProviderStore(db as never).listLiveGrantClients();
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
      expect(plan).toMatch(
        /SEARCH i USING INDEX idx_items_type_state \(type=\? AND state=\?\)/,
      );
      expect(plan).toMatch(
        /SEARCH c USING INDEX (idx_auth_oauth_client_client_id|sqlite_autoindex_auth_oauth_client_\d+) \(client_id=\?\)/,
      );
      expect(plan).not.toMatch(/SCAN i\b/);
      expect(plan).not.toContain("idx_items_state");
    } finally {
      client.close();
    }
  });
});
