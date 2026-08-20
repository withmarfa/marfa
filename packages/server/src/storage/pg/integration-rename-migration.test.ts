/**
 * The Postgres half of the identifier rename (migration 0088).
 *
 * This is the dialect the hosted deployments run, and the two statements are
 * necessarily different — one stores `properties` as `jsonb`, the other as
 * binary JSONB — so the Postgres one is replayed against a real Postgres
 * rather than trusted to match its SQLite sibling.
 *
 * All three stored places must move together: the catalog's `manifest_name`,
 * the `name` inside the frozen manifest (what a connection resolves and what
 * dispatch routes by), and `items.source` on every owned row.
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
    "../../../drizzle/pg/0088_integration_identifiers_take_the_slash.sql",
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

describe.skipIf(!isPg)("0088 integration identifiers take the slash", () => {
  it("moves the catalog key, the frozen manifest and provenance together", async () => {
    const db = ctx.storage.pgDb as PgDb;
    const stamp = String(Date.now());
    const ids = {
      catPodcasts: `ren-${stamp}-a`,
      catReader: `ren-${stamp}-b`,
      catThirdParty: `ren-${stamp}-c`,
      rowEpisode: `ren-${stamp}-d`,
      rowUser: `ren-${stamp}-e`,
      rowAcme: `ren-${stamp}-f`,
    };
    const seed: [string, string, string, unknown][] = [
      [
        ids.catPodcasts,
        "system.integration",
        "unknown",
        {
          manifest_name: "withmarfa.podcasts",
          manifest: { name: "withmarfa.podcasts", version: "0.1.0" },
        },
      ],
      [
        ids.catReader,
        "system.integration",
        "unknown",
        {
          manifest_name: "readwise.reader",
          manifest: { name: "readwise.reader" },
        },
      ],
      [
        ids.catThirdParty,
        "system.integration",
        "unknown",
        { manifest_name: "acme.widgets", manifest: { name: "acme.widgets" } },
      ],
      [
        ids.rowEpisode,
        "marfa.podcast.episode",
        "integration:withmarfa.podcasts",
        {},
      ],
      [ids.rowUser, "core.note", "cli", {}],
      [ids.rowAcme, "core.note", "integration:acme.widgets", {}],
    ];
    for (const [id, type, source, props] of seed) {
      await db.execute(sql`
        INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, timestamp, version, source, schema_version)
        VALUES (${id}, ${type}, 'active', 'library', ${JSON.stringify(props)}::jsonb,
                now(), now(), now(), 1, ${source}, 2)
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

      const props = async (id: string): Promise<Record<string, unknown>> => {
        const r = await db.execute(
          sql`SELECT properties FROM items WHERE id = ${id}`,
        );
        return (r as unknown as { properties: Record<string, unknown> }[])[0]!
          .properties;
      };
      const source = async (id: string): Promise<string> => {
        const r = await db.execute(
          sql`SELECT source FROM items WHERE id = ${id}`,
        );
        return (r as unknown as { source: string }[])[0]!.source;
      };

      const podcasts = await props(ids.catPodcasts);
      expect(podcasts.manifest_name).toBe("marfa/podcasts");
      expect((podcasts.manifest as { name: string }).name).toBe(
        "marfa/podcasts",
      );
      expect((podcasts.manifest as { version: string }).version).toBe("0.1.0");

      expect((await props(ids.catReader)).manifest_name).toBe(
        "readwise/reader",
      );

      // A third-party integration is not in the table and does not move.
      expect((await props(ids.catThirdParty)).manifest_name).toBe(
        "acme.widgets",
      );
      expect(await source(ids.rowAcme)).toBe("integration:acme.widgets");

      expect(await source(ids.rowEpisode)).toBe("integration:marfa/podcasts");
      expect(await source(ids.rowUser)).toBe("cli");

      // `withmarfa.podcasts` moved while `marfa.podcast.episode` did not: they
      // share a prefix, one is an integration and one a type, and a pattern
      // sweep would have taken both.
      const t = await db.execute(
        sql`SELECT type FROM items WHERE id = ${ids.rowEpisode}`,
      );
      expect((t as unknown as { type: string }[])[0]!.type).toBe(
        "marfa.podcast.episode",
      );

      // Idempotent.
      await run();
      expect((await props(ids.catPodcasts)).manifest_name).toBe(
        "marfa/podcasts",
      );
      expect(await source(ids.rowEpisode)).toBe("integration:marfa/podcasts");
    } finally {
      for (const id of Object.values(ids)) {
        await db.execute(sql`DELETE FROM items WHERE id = ${id}`);
      }
    }
  });
});
