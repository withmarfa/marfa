/**
 * Equality test for the auto-generated SQLite SCHEMA_SQL (T-145).
 *
 * Applies migrations to one fresh DB and SCHEMA_SQL to a second fresh DB,
 * then dumps the schema from each and asserts equality. If the generator
 * drops or reshapes anything the migrations actually produce, this test
 * catches it.
 *
 * The snapshot is the dump itself (not a hand-curated checklist), so the
 * comparison is mechanically complete — defaults, FKs, indexes, all of it.
 *
 * Uses temp files (one per DB) rather than `:memory:` so the two DBs are
 * fully isolated — libsql's `file::memory:?cache=shared` only gives one
 * shared in-memory DB across the process.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runSqliteMigrations } from "../migrate.js";
import { SCHEMA_SQL } from "./schema-sql.generated.js";

interface SchemaRow {
  type: string;
  name: string;
  sql: string;
}

async function dumpSchema(client: Client): Promise<SchemaRow[]> {
  const result = await client.execute({
    sql: `
      SELECT type, name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name NOT LIKE 'sqlite_%'
        AND name != '__drizzle_migrations'
        AND sql IS NOT NULL
      ORDER BY type, name
    `,
    args: [],
  });
  return result.rows.map((r) => ({
    type: r.type as string,
    name: r.name as string,
    sql: (r.sql as string).trim(),
  }));
}

const workDir = mkdtempSync(join(tmpdir(), "myme-schema-sql-test-"));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("SCHEMA_SQL equivalence (T-145)", () => {
  it("produces the same schema as running migrations from 0000", async () => {
    // DB 1: migrations applied via Drizzle's migrator.
    const migrationsPath = join(workDir, "migrations.db");
    await runSqliteMigrations(migrationsPath);
    const migrationsClient = createClient({ url: `file:${migrationsPath}` });
    const fromMigrations = await dumpSchema(migrationsClient);
    migrationsClient.close();

    // DB 2: SCHEMA_SQL applied directly.
    const schemaSqlPath = join(workDir, "schema-sql.db");
    const schemaSqlClient = createClient({ url: `file:${schemaSqlPath}` });
    await schemaSqlClient.executeMultiple(SCHEMA_SQL);
    const fromSchemaSql = await dumpSchema(schemaSqlClient);
    schemaSqlClient.close();

    // Both dumps must carry the same objects.
    const migrationsKeys = fromMigrations.map((r) => `${r.type}:${r.name}`);
    const schemaSqlKeys = fromSchemaSql.map((r) => `${r.type}:${r.name}`);
    expect(schemaSqlKeys).toEqual(migrationsKeys);

    // Each object's DDL must match. The generator adds `IF NOT EXISTS` for
    // re-run safety; semantically identical, so strip before comparing.
    const stripIfNotExists = (sql: string): string =>
      sql.replace(/\bIF NOT EXISTS\b\s*/gi, "");
    for (let i = 0; i < fromMigrations.length; i++) {
      const mig = fromMigrations[i]!;
      const fromSql = fromSchemaSql[i]!;
      const migDdl = stripIfNotExists(mig.sql);
      const sqlDdl = stripIfNotExists(fromSql.sql);
      expect(sqlDdl, `${mig.type}:${mig.name}`).toBe(migDdl);
    }
  });
});
