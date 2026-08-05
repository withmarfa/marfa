import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the shipped provenance migration against a pre-migration shape:
 * connection-keyed sources resolve to their integration's manifest name,
 * unrelated sources stay untouched, and a source whose Connection cannot
 * be resolved is left alone rather than nulled.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0063_integration_keyed_provenance.sql",
  ),
  "utf8",
);

describe.skipIf((process.env.DB_DIALECT ?? "sqlite") === "pg")(
  "0063 integration-keyed provenance migration",
  () => {
    it("rewrites connection-keyed sources and only those", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await db.execute(
          "CREATE TABLE items (id text PRIMARY KEY, type text, source text, source_id text, properties blob)",
        );
        const seed = [
          `INSERT INTO items VALUES ('ii1','system.integration',NULL,NULL,jsonb('{"manifest_name":"acme.feed"}'))`,
          `INSERT INTO items VALUES ('c1','system.connection',NULL,NULL,jsonb('{"integration_ref":"ii1"}'))`,
          `INSERT INTO items VALUES ('x1','core.note','integration:c1','u1',jsonb('{}'))`,
          `INSERT INTO items VALUES ('x2','core.note','cli','u2',jsonb('{}'))`,
          `INSERT INTO items VALUES ('x3','core.note','integration:ghost','u3',jsonb('{}'))`,
        ];
        for (const s of seed) await db.execute(s);

        for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
          const s = stmt
            .split("\n")
            .filter((l) => !l.trimStart().startsWith("--"))
            .join("\n")
            .trim();
          if (s.length > 0) await db.execute(s);
        }

        const rows = await db.execute(
          "SELECT id, source FROM items WHERE id LIKE 'x%' ORDER BY id",
        );
        expect(rows.rows.map((r) => [r.id, r.source])).toEqual([
          ["x1", "integration:acme.feed"],
          ["x2", "cli"],
          ["x3", "integration:ghost"],
        ]);
      } finally {
        db.close();
      }
    });
  },
);
