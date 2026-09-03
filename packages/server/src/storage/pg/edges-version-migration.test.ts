/**
 * The Postgres half of the migration that gives an edge a version.
 *
 * This is the dialect the deployments run, so the statement is replayed
 * against a real Postgres rather than trusted to match the SQLite sibling —
 * the two files are written by hand in different syntax, and neither is
 * evidence for the other.
 *
 * The case it covers is the one no fresh-database job reaches: a table that
 * already holds rows. Those jobs apply the whole chain to an empty database,
 * where a column added nullable or without a default passes cleanly and then
 * leaves every existing edge at NULL on a real deployment, with a
 * precondition that can never match.
 *
 * The replay runs in a schema of its own so it meets a pre-migration table:
 * the bootstrap the test database was built from already carries the column,
 * and an `ALTER TABLE` adding it again is an error rather than a no-op.
 *
 * SQLite skips the suite.
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
  join(__dirname, "../../../drizzle/pg/0097_an_edge_carries_a_version.sql"),
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

describe.skipIf(!isPg)("0097 an edge carries a version", () => {
  const db = () => ctx.storage.pgDb as PgDb;

  it("gives every existing row version 1, and every later one too", async () => {
    const schema = `edge_ver_${Math.random().toString(36).slice(2, 10)}`;
    await db().execute(sql.raw(`CREATE SCHEMA ${schema}`));
    try {
      await db().execute(
        sql.raw(`
          CREATE TABLE ${schema}.edges (
            id text PRIMARY KEY,
            space_id text,
            source_id text NOT NULL,
            target_id text NOT NULL,
            edge_type text NOT NULL,
            properties text NOT NULL DEFAULT '{}',
            created_at text NOT NULL,
            updated_at text NOT NULL
          )
        `),
      );
      await db().execute(
        sql.raw(`
          INSERT INTO ${schema}.edges VALUES
            ('e1','s1','a','b','references','{}','t','t'),
            ('e2','s1','a','c','references','{}','t','t')
        `),
      );

      // The statement names `edges` unqualified, so the search path is what
      // points it at the pre-migration table rather than the real one.
      const statements = MIGRATION.split("--> statement-breakpoint")
        .map((stmt) =>
          stmt
            .split("\n")
            .filter((l) => !l.trimStart().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter((s) => s.length > 0);
      for (const statement of statements) {
        await db().execute(
          sql.raw(`SET LOCAL search_path TO ${schema}; ${statement}`),
        );
      }

      const existing = await db().execute(
        sql.raw(`SELECT id, version FROM ${schema}.edges ORDER BY id`),
      );
      expect([...existing].map((r) => [r.id, r.version])).toEqual([
        ["e1", 1],
        ["e2", 1],
      ]);

      // The build that follows this migration names the column on every
      // insert, but the build serving the deploy window does not. That write
      // has to land at 1 rather than fail on the NOT NULL.
      await db().execute(
        sql.raw(`
          INSERT INTO ${schema}.edges
            (id, space_id, source_id, target_id, edge_type, properties, created_at, updated_at)
          VALUES ('e3','s1','a','d','references','{}','t','t')
        `),
      );
      const later = await db().execute(
        sql.raw(`SELECT version FROM ${schema}.edges WHERE id = 'e3'`),
      );
      expect([...later][0]?.version).toBe(1);
    } finally {
      await db().execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
    }
  });
});
