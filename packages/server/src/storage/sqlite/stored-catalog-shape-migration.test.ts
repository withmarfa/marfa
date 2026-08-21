import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the catalog normalization against rows frozen under the previous
 * manifest contract.
 *
 * The property under test is the one that decides whether the validator's
 * transitional tolerances can ever come out. A stored manifest is validated
 * on every resolution and a credential mint fails closed when resolution
 * fails, so a row still carrying the retired key or the old schema major
 * stops resolving the moment the tolerance is removed. Both copies of the
 * key have to go — the frozen blob and the denormalized one — and the
 * schema version has to describe the shape the row now has.
 *
 * A row already written under the current contract is left exactly as it
 * is, including its own schema version, which is what stops this from
 * flattening a future minor onto 2.0.0.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0076_stored_catalog_rows_take_the_current_manifest_shape.sql",
  ),
  "utf8",
);

describe.skipIf((process.env.DB_DIALECT ?? "sqlite") === "pg")(
  "0076 stored catalog rows take the current manifest shape",
  () => {
    it("strips both copies and restamps the version, and only where it should", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await db.execute(
          "CREATE TABLE items (id text PRIMARY KEY, type text, properties blob)",
        );

        // Both copies present: the shape every row registered before the
        // contract moved is in.
        const stale = {
          manifest_name: "marfa/inbox",
          manifest_version: "0.1.0",
          runtime_compatibility: ["hosted", "local"],
          manifest: {
            name: "marfa/inbox",
            manifest_schema_version: "1.0.0",
            runtime_compatibility: ["hosted", "local"],
            target_types: ["marfa.captured_email"],
          },
        };
        // Denormalized copy only. The nested removal must tolerate a path
        // that is not there rather than failing the statement.
        const partial = {
          manifest_name: "marfa/podcasts",
          runtime_compatibility: ["local"],
          manifest: {
            name: "marfa/podcasts",
            manifest_schema_version: "1.3.0",
          },
        };
        // Already current, and deliberately not on 2.0.0: an untouched row
        // keeps the version it was registered with.
        const current = {
          manifest_name: "marfa/rss-watcher",
          manifest: {
            name: "marfa/rss-watcher",
            manifest_schema_version: "2.1.0",
          },
        };
        // Not a catalog row, and carries the key: must not be touched.
        const note = {
          body: "runtime_compatibility used to be a manifest field",
        };

        const seed: [string, string, unknown][] = [
          ["c1", "system.integration", stale],
          ["c2", "system.integration", partial],
          ["c3", "system.integration", current],
          ["n1", "core.note", note],
        ];
        for (const [id, type, props] of seed) {
          await db.execute({
            sql: "INSERT INTO items VALUES (?, ?, jsonb(?))",
            args: [id, type, JSON.stringify(props)],
          });
        }

        const run = async (): Promise<number> => {
          let affected = 0;
          for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
            const s = stmt
              .split("\n")
              .filter((l) => !l.trimStart().startsWith("--"))
              .join("\n")
              .trim();
            if (s.length > 0) affected += (await db.execute(s)).rowsAffected;
          }
          return affected;
        };

        expect(await run()).toBe(2);
        // Idempotent: the guard matches only rows still carrying the key.
        expect(await run()).toBe(0);

        const read = async (id: string): Promise<Record<string, unknown>> => {
          const r = await db.execute({
            sql: "SELECT json(properties) AS p FROM items WHERE id = ?",
            args: [id],
          });
          return JSON.parse(r.rows[0]!.p as string) as Record<string, unknown>;
        };

        const after1 = await read("c1");
        expect("runtime_compatibility" in after1).toBe(false);
        const m1 = after1.manifest as Record<string, unknown>;
        expect("runtime_compatibility" in m1).toBe(false);
        expect(m1.manifest_schema_version).toBe("2.0.0");
        // Everything the row froze other than the retired field survives.
        expect(m1.target_types).toEqual(["marfa.captured_email"]);
        expect(after1.manifest_name).toBe("marfa/inbox");
        expect(after1.manifest_version).toBe("0.1.0");

        const after2 = await read("c2");
        expect("runtime_compatibility" in after2).toBe(false);
        expect(
          (after2.manifest as Record<string, unknown>).manifest_schema_version,
        ).toBe("2.0.0");

        expect(await read("c3")).toEqual(current);
        expect(await read("n1")).toEqual(note);
      } finally {
        db.close();
      }
    });
  },
);
