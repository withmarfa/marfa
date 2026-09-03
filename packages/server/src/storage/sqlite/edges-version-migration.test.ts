/**
 * The SQLite half of the migration that gives an edge a version.
 *
 * Replays the shipped statement against a pre-migration `edges` table
 * holding rows, which is the case no other check reaches: the fresh-database
 * jobs apply the whole chain to an empty database, so a column added
 * nullable, or without a default, passes every one of them. What it would
 * produce on a real deployment is an edge whose version is NULL, and a
 * precondition that can then never match — a client would be refused
 * forever with no way to learn what to send instead.
 *
 * Postgres skips the suite; its sibling covers the same ground against a
 * real server, because the two dialects' statements are written by hand and
 * neither is evidence for the other.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION = readFileSync(
  join(__dirname, "../../../drizzle/sqlite/0083_an_edge_carries_a_version.sql"),
  "utf8",
);

describe.skipIf((process.env.DB_DIALECT ?? "sqlite") === "pg")(
  "0083 an edge carries a version",
  () => {
    it("gives every existing row version 1, and every later one too", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await db.execute(
          "CREATE TABLE edges (id text PRIMARY KEY, space_id text, source_id text NOT NULL, target_id text NOT NULL, edge_type text NOT NULL, properties text NOT NULL DEFAULT '{}', created_at text NOT NULL, updated_at text NOT NULL)",
        );
        for (const id of ["e1", "e2"]) {
          await db.execute(
            `INSERT INTO edges VALUES ('${id}','s1','a','b','references','{}','t','t')`,
          );
        }

        for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
          const s = stmt
            .split("\n")
            .filter((l) => !l.trimStart().startsWith("--"))
            .join("\n")
            .trim();
          if (s.length > 0) await db.execute(s);
        }

        const existing = await db.execute(
          "SELECT id, version FROM edges ORDER BY id",
        );
        expect(existing.rows.map((r) => [r.id, r.version])).toEqual([
          ["e1", 1],
          ["e2", 1],
        ]);

        // The build that follows this migration names the column on every
        // insert, but the build serving the deploy window does not. That
        // write has to land at 1 rather than fail on the NOT NULL.
        await db.execute(
          "INSERT INTO edges (id, space_id, source_id, target_id, edge_type, properties, created_at, updated_at) VALUES ('e3','s1','a','b','references','{}','t','t')",
        );
        const later = await db.execute(
          "SELECT version FROM edges WHERE id = 'e3'",
        );
        expect(later.rows[0]?.version).toBe(1);
      } finally {
        db.close();
      }
    });
  },
);
