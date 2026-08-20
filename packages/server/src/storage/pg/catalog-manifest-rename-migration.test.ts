/**
 * The Postgres half of the catalog rewrite (migration 0087).
 *
 * This is the dialect the hosted deployments run, so the SQL is replayed
 * against a real Postgres rather than trusted to match its SQLite sibling:
 * one stores `properties` as `jsonb` and the other as binary JSONB, so the
 * two statements are necessarily different and only a live run proves the
 * Postgres one round-trips.
 *
 * The property under test is the one that broke live: a runtime
 * credential's write permission is projected from the RESOLVED manifest's
 * `target_types`, so a catalog row left on the old identifiers refuses the
 * integration's own writes however current the shipped code is.
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
    "../../../drizzle/pg/0087_catalog_manifests_carry_the_type_rename.sql",
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

describe.skipIf(!isPg)("0087 catalog manifests carry the type rename", () => {
  it("rewrites frozen target types and prose, and only where it should", async () => {
    const db = ctx.storage.pgDb as PgDb;

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

    const stamp = String(Date.now());
    const ids = {
      inbox: `mig-cat-${stamp}-a`,
      podcasts: `mig-cat-${stamp}-b`,
      renamed: `mig-cat-${stamp}-c`,
      note: `mig-cat-${stamp}-d`,
    };
    const seed: [string, string, unknown][] = [
      [ids.inbox, "system.integration", inbox],
      [ids.podcasts, "system.integration", podcasts],
      [ids.renamed, "system.integration", renamed],
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
      for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
        const s = stmt
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("--"))
          .join("\n")
          .trim();
        if (s.length > 0) await db.execute(sql.raw(s));
      }

      const read = async (id: string): Promise<Record<string, unknown>> => {
        const r = await db.execute(
          sql`SELECT properties FROM items WHERE id = ${id}`,
        );
        const row = (r as unknown as { properties: unknown }[])[0]!;
        return row.properties as Record<string, unknown>;
      };

      const after1 = await read(ids.inbox);
      expect(
        (after1.manifest as { target_types: string[] }).target_types,
      ).toEqual(["marfa.captured_email"]);
      // The prose a person reads moves with the array it describes.
      expect(after1.summary).toBe(
        "lands each delivery as a `marfa.captured_email` item.",
      );
      // The integration's own identifier is a separate change.
      expect(after1.manifest_name).toBe("withmarfa.inbox");

      const after2 = await read(ids.podcasts);
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

      expect(await read(ids.renamed)).toEqual(renamed);
      expect(await read(ids.note)).toEqual(note);
    } finally {
      for (const id of Object.values(ids)) {
        await db.execute(sql`DELETE FROM items WHERE id = ${id}`);
      }
    }
  });
});
