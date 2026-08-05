import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the shipped migration file against a database in the pre-migration
 * shape, so the rebuild-and-convert SQL is proven to carry data across — the
 * fresh-migrate CI legs only ever run the chain against empty databases.
 */
const MIGRATION = readFileSync(
  join(__dirname, "../../../drizzle/sqlite/0062_items_properties_jsonb.sql"),
  "utf8",
);

const OLD_ITEMS = `CREATE TABLE \`items\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`space_id\` text,
  \`type\` text NOT NULL,
  \`state\` text DEFAULT 'active' NOT NULL,
  \`properties\` text NOT NULL,
  \`created_at\` text NOT NULL,
  \`updated_at\` text NOT NULL,
  \`timestamp\` text NOT NULL,
  \`source\` text,
  \`source_id\` text,
  \`version\` integer DEFAULT 1 NOT NULL,
  \`schema_version\` integer,
  \`device\` text,
  \`capture_latitude\` real,
  \`capture_longitude\` real,
  \`tier\` text DEFAULT 'library' NOT NULL
)`;

const seeded: Record<string, unknown>[] = [
  { title: "plain" },
  { title: "Ünïcode \u{1F30D}", nested: { a: [1, 2, { b: null }] } },
  { frac: 0.1, big: 9007199254740991, small: 1e-10 },
  { empty_obj: {}, empty_arr: [], escaped: 'quote " backslash \\ newline\n' },
];

describe.skipIf((process.env.DB_DIALECT ?? "sqlite") === "pg")(
  "0062 items properties migration",
  () => {
    it("converts existing text rows to JSONB blobs, object-equivalently", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await db.execute(OLD_ITEMS);
        for (let i = 0; i < seeded.length; i++) {
          await db.execute({
            sql: `INSERT INTO items (id, type, properties, created_at, updated_at, timestamp)
                  VALUES (?, 'core.note', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
            args: [`item-${String(i)}`, JSON.stringify(seeded[i])],
          });
        }

        for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
          const sql = stmt
            .split("\n")
            .filter((l) => !l.trimStart().startsWith("--"))
            .join("\n")
            .trim();
          if (sql.length > 0) await db.execute(sql);
        }

        const rows = await db.execute(
          "SELECT id, typeof(properties) AS enc, json(properties) AS props FROM items ORDER BY id",
        );
        expect(rows.rows.length).toBe(seeded.length);
        for (let i = 0; i < seeded.length; i++) {
          const row = rows.rows[i] as unknown as {
            id: string;
            enc: string;
            props: string;
          };
          expect(row.enc).toBe("blob");
          expect(JSON.parse(row.props)).toEqual(seeded[i]);
        }

        // The rebuild must put every index back, the unique dedup included.
        const indexes = await db.execute("PRAGMA index_list('items')");
        const names = indexes.rows.map((r) => (r as { name?: unknown }).name);
        for (const expected of [
          "idx_items_type",
          "idx_items_state",
          "idx_items_created_at",
          "idx_items_timestamp",
          "idx_items_source_dedup",
        ]) {
          expect(names).toContain(expected);
        }
      } finally {
        db.close();
      }
    });
  },
);
