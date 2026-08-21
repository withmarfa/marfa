/**
 * The Postgres half of the catalog normalization (migration 0090).
 *
 * This is the dialect the hosted deployments run, so the SQL is replayed
 * against a real Postgres rather than trusted to match its SQLite sibling:
 * the two store `properties` differently and the statements are necessarily
 * different, so only a live run proves this one round-trips.
 *
 * The property under test decides whether the validator's transitional
 * tolerances can ever come out. A stored manifest is validated on every
 * resolution and a credential mint fails closed when resolution fails, so a
 * row still carrying the retired key or the old schema major stops
 * resolving the moment a tolerance is removed.
 *
 * SQLite skips the suite; its sibling covers that dialect.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/pg/0090_stored_catalog_rows_take_the_current_manifest_shape.sql",
  ),
  "utf8",
);

let ctx: TestContext;

beforeAll(async () => {
  if (!isPg) return;
  ctx = await createTestContext();
});

afterAll(async () => {
  if (!isPg) return;
  await ctx.cleanup();
});

describe.skipIf(!isPg)(
  "0090 stored catalog rows take the current manifest shape",
  () => {
    it("strips both copies and restamps the version, and only where it should", async () => {
      const db = ctx.storage.pgDb as PgDb;

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
        manifest: { name: "marfa/podcasts", manifest_schema_version: "1.3.0" },
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

      const stamp = String(Date.now());
      const ids = {
        stale: `mig-shape-${stamp}-a`,
        partial: `mig-shape-${stamp}-b`,
        current: `mig-shape-${stamp}-c`,
        note: `mig-shape-${stamp}-d`,
      };
      const seed: [string, string, unknown][] = [
        [ids.stale, "system.integration", stale],
        [ids.partial, "system.integration", partial],
        [ids.current, "system.integration", current],
        [ids.note, "core.note", note],
      ];
      for (const [id, type, props] of seed) {
        await db.execute(sql`
          INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, timestamp, version, source, schema_version)
          VALUES (${id}, ${type}, 'active', 'library', ${JSON.stringify(props)}::jsonb,
                  now(), now(), now(), 1, 'test', 2)
        `);
      }

      try {
        const run = async (): Promise<void> => {
          for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
            const s = stmt
              .split("\n")
              .filter((l) => !l.trimStart().startsWith("--"))
              .join("\n")
              .trim();
            if (s.length > 0) await db.execute(sql.raw(s));
          }
        };
        await run();
        // Idempotent: the guard matches only rows still carrying the key,
        // so replaying it changes nothing.
        await run();

        const read = async (id: string): Promise<Record<string, unknown>> => {
          const r = await db.execute(
            sql`SELECT properties FROM items WHERE id = ${id}`,
          );
          const row = (r as unknown as { properties: unknown }[])[0]!;
          return row.properties as Record<string, unknown>;
        };

        const after1 = await read(ids.stale);
        expect("runtime_compatibility" in after1).toBe(false);
        const m1 = after1.manifest as Record<string, unknown>;
        expect("runtime_compatibility" in m1).toBe(false);
        expect(m1.manifest_schema_version).toBe("2.0.0");
        // Everything the row froze other than the retired field survives.
        expect(m1.target_types).toEqual(["marfa.captured_email"]);
        expect(after1.manifest_name).toBe("marfa/inbox");
        expect(after1.manifest_version).toBe("0.1.0");

        const after2 = await read(ids.partial);
        expect("runtime_compatibility" in after2).toBe(false);
        expect(
          (after2.manifest as Record<string, unknown>).manifest_schema_version,
        ).toBe("2.0.0");

        expect(await read(ids.current)).toEqual(current);
        expect(await read(ids.note)).toEqual(note);
      } finally {
        await db.execute(
          sql`DELETE FROM items WHERE id IN (${ids.stale}, ${ids.partial}, ${ids.current}, ${ids.note})`,
        );
      }
    });
  },
);
