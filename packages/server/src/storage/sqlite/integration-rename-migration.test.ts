import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the identifier rename against pre-rename rows.
 *
 * Three stored places carry an integration's name and all three must move
 * together: the catalog's `manifest_name`, the `name` inside the frozen
 * manifest on the same row (what a connection actually resolves), and
 * `items.source` on every row the integration owns. Moving only some of them
 * fails quietly — dispatch keeps routing by the frozen name, and a row left on
 * the old source is re-created as a duplicate on the next sync and locked
 * against its own owner by the mirror write-door.
 *
 * The case that makes a pattern replacement wrong is pinned here:
 * `withmarfa.podcasts` is an integration and `withmarfa.podcast.show` is a
 * type, they share a prefix, and only the first may move.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0074_integration_identifiers_take_the_slash.sql",
  ),
  "utf8",
);

describe("0074 integration identifiers take the slash", () => {
  it("moves the catalog key, the frozen manifest and provenance together", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await db.execute(
        "CREATE TABLE items (id text PRIMARY KEY, type text, source text, properties blob)",
      );
      const seed: [string, string, string | null, unknown][] = [
        [
          "cat-podcasts",
          "system.integration",
          null,
          {
            manifest_name: "withmarfa.podcasts",
            manifest: { name: "withmarfa.podcasts", version: "0.1.0" },
          },
        ],
        [
          "cat-reader",
          "system.integration",
          null,
          {
            manifest_name: "readwise.reader",
            manifest: { name: "readwise.reader" },
          },
        ],
        [
          "cat-third-party",
          "system.integration",
          null,
          {
            manifest_name: "acme.widgets",
            manifest: { name: "acme.widgets" },
          },
        ],
        // An owned row, and a type row that shares the integration's prefix.
        [
          "row-ep",
          "marfa.podcast.episode",
          "integration:withmarfa.podcasts",
          {},
        ],
        ["row-doc", "readwise.document", "integration:readwise.reader", {}],
        ["row-user", "core.note", "cli", {}],
        ["row-acme", "core.note", "integration:acme.widgets", {}],
      ];
      for (const [id, type, source, props] of seed) {
        await db.execute({
          sql: "INSERT INTO items VALUES (?, ?, ?, jsonb(?))",
          args: [id, type, source, JSON.stringify(props)],
        });
      }

      for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
        const s = stmt
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("--"))
          .join("\n")
          .trim();
        if (s.length > 0) await db.execute(s);
      }

      const props = async (id: string): Promise<Record<string, unknown>> => {
        const r = await db.execute({
          sql: "SELECT json(properties) AS p FROM items WHERE id = ?",
          args: [id],
        });
        return JSON.parse(r.rows[0]!.p as string) as Record<string, unknown>;
      };
      const source = async (id: string): Promise<string | null> => {
        const r = await db.execute({
          sql: "SELECT source FROM items WHERE id = ?",
          args: [id],
        });
        return r.rows[0]!.source as string | null;
      };

      const podcasts = await props("cat-podcasts");
      expect(podcasts.manifest_name).toBe("marfa/podcasts");
      // The frozen manifest is what a connection resolves; the catalog key
      // alone moving would leave dispatch on the old name.
      expect((podcasts.manifest as { name: string }).name).toBe(
        "marfa/podcasts",
      );
      expect((podcasts.manifest as { version: string }).version).toBe("0.1.0");

      const reader = await props("cat-reader");
      expect(reader.manifest_name).toBe("readwise/reader");
      expect((reader.manifest as { name: string }).name).toBe(
        "readwise/reader",
      );

      // A third-party integration is not in the table and does not move.
      expect((await props("cat-third-party")).manifest_name).toBe(
        "acme.widgets",
      );
      expect(await source("row-acme")).toBe("integration:acme.widgets");

      expect(await source("row-ep")).toBe("integration:marfa/podcasts");
      expect(await source("row-doc")).toBe("integration:readwise/reader");
      expect(await source("row-user")).toBe("cli");

      // The type identifier sharing the integration's prefix is untouched:
      // `withmarfa.podcasts` moved, `marfa.podcast.episode` was never a
      // candidate, and a prefix sweep would have taken both.
      const t = await db.execute("SELECT type FROM items WHERE id = 'row-ep'");
      expect(t.rows[0]!.type).toBe("marfa.podcast.episode");
    } finally {
      db.close();
    }
  });

  it("is idempotent", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await db.execute(
        "CREATE TABLE items (id text PRIMARY KEY, type text, source text, properties blob)",
      );
      await db.execute({
        sql: "INSERT INTO items VALUES ('c','system.integration',NULL,jsonb(?))",
        args: [
          JSON.stringify({
            manifest_name: "marfa/podcasts",
            manifest: { name: "marfa/podcasts" },
          }),
        ],
      });
      const run = async (): Promise<void> => {
        for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
          const s = stmt
            .split("\n")
            .filter((l) => !l.trimStart().startsWith("--"))
            .join("\n")
            .trim();
          if (s.length > 0) await db.execute(s);
        }
      };
      await run();
      await run();
      const r = await db.execute("SELECT json(properties) AS p FROM items");
      expect(JSON.parse(r.rows[0]!.p as string)).toEqual({
        manifest_name: "marfa/podcasts",
        manifest: { name: "marfa/podcasts" },
      });
    } finally {
      db.close();
    }
  });
});
