import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the catalog rewrite against a frozen pre-rename manifest.
 *
 * The property under test is the one that broke live: a runtime
 * credential's write permission is projected from the RESOLVED manifest's
 * `target_types`, so a catalog row left on the old identifiers refuses the
 * integration's own writes however current the shipped code is. The prose
 * fields move with the array, an integration whose name merely starts with
 * the podcast type prefix is not caught, and a row already carrying the new
 * identifiers is left exactly as it is.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0073_catalog_manifests_carry_the_type_rename.sql",
  ),
  "utf8",
);

describe.skipIf((process.env.DB_DIALECT ?? "sqlite") === "pg")(
  "0073 catalog manifests carry the type rename",
  () => {
    it("rewrites frozen target types and prose, and only where it should", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await db.execute(
          "CREATE TABLE items (id text PRIMARY KEY, type text, properties blob)",
        );

        const inbox = {
          summary: "lands each delivery as a `withmarfa.captured_email` item.",
          manifest_name: "withmarfa.inbox",
          manifest: {
            name: "withmarfa.inbox",
            target_types: ["withmarfa.captured_email"],
          },
        };
        const podcasts = {
          manifest_name: "withmarfa.podcasts",
          manifest: {
            name: "withmarfa.podcasts",
            target_types: [
              "withmarfa.podcast.show",
              "withmarfa.podcast.episode",
              "core.media.series",
            ],
          },
        };
        // Already renamed: the migration must be a no-op over it.
        const renamed = {
          manifest_name: "acme.done",
          manifest: { target_types: ["marfa.captured_email"] },
        };
        // Not a catalog row, and carries the literal: must not be touched.
        const note = { body: "about withmarfa.captured_email" };

        const seed: [string, string, unknown][] = [
          ["ii1", "system.integration", inbox],
          ["ii2", "system.integration", podcasts],
          ["ii3", "system.integration", renamed],
          ["n1", "core.note", note],
        ];
        for (const [id, type, props] of seed) {
          await db.execute({
            sql: "INSERT INTO items VALUES (?, ?, jsonb(?))",
            args: [id, type, JSON.stringify(props)],
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

        const read = async (id: string): Promise<Record<string, unknown>> => {
          const r = await db.execute({
            sql: "SELECT json(properties) AS p FROM items WHERE id = ?",
            args: [id],
          });
          const rendered = r.rows[0]!.p as string;
          return JSON.parse(rendered) as Record<string, unknown>;
        };

        const after1 = await read("ii1");
        expect(
          (after1.manifest as { target_types: string[] }).target_types,
        ).toEqual(["marfa.captured_email"]);
        // The prose a person reads moves with the array it describes.
        expect(after1.summary).toBe(
          "lands each delivery as a `marfa.captured_email` item.",
        );
        // The integration's own identifier is a separate change.
        expect(after1.manifest_name).toBe("withmarfa.inbox");

        const after2 = await read("ii2");
        expect(
          (after2.manifest as { target_types: string[] }).target_types,
        ).toEqual([
          "marfa.podcast.show",
          "marfa.podcast.episode",
          "core.media.series",
        ]);
        // `withmarfa.podcasts` shares a prefix with the podcast types and
        // must survive the replacement intact.
        expect(after2.manifest_name).toBe("withmarfa.podcasts");

        expect(await read("ii3")).toEqual(renamed);
        expect(await read("n1")).toEqual(note);
      } finally {
        db.close();
      }
    });
  },
);
