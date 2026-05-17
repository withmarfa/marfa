/**
 * Re-run safety test for the auto-generated Postgres SCHEMA_SQL (T-145).
 *
 * SCHEMA_SQL runs on every server boot via createConnection() — once on a
 * fresh DB to populate it, and again on every subsequent boot to no-op.
 * The latter is the property this test guards: applying SCHEMA_SQL to an
 * already-bootstrapped DB must not error.
 *
 * Fresh-apply correctness is exercised by the rest of the PG test suite —
 * every createTestContext() invocation boots through createConnection()
 * and SCHEMA_SQL. If a CREATE TABLE statement were malformed, 1000+
 * downstream tests would surface it before this one.
 *
 * Drift between SCHEMA_SQL and the migrations is caught by the
 * `schema-sql-freshness` CI job, which regenerates the artefact and
 * `git diff --exit-code`s it.
 *
 * Skips when DATABASE_URL is unset (i.e. not under `pnpm test:pg`).
 */

import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { SCHEMA_SQL } from "./schema-sql.generated.js";

const databaseUrl = process.env.DATABASE_URL;
const describeOrSkip = databaseUrl ? describe : describe.skip;

describeOrSkip("SCHEMA_SQL re-run safety — Postgres (T-145)", () => {
  it("re-applies cleanly against an already-bootstrapped DB", async () => {
    // The test:pg framework already created tables in `public` via
    // createConnection() / SCHEMA_SQL on this DB. Re-applying SCHEMA_SQL
    // must complete without errors — the CREATE TABLE IF NOT EXISTS,
    // DROP POLICY IF EXISTS + CREATE POLICY, and DO IF NOT EXISTS
    // wrappers for ADD CONSTRAINT / ADD IDENTITY all guarantee
    // idempotency.
    const sql = postgres(databaseUrl!, {
      max: 1,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onnotice: () => {},
    });
    try {
      await expect(sql.unsafe(SCHEMA_SQL)).resolves.toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it("emits the expected role + grant baseline", async () => {
    // Sanity check: SCHEMA_SQL grew the myme_app role and granted CRUD on
    // the tenant-scoped tables. The freshness check covers drift; this is
    // a sanity bound so a future generator regression that silently drops
    // grants would fail loud.
    const sql = postgres(databaseUrl!, {
      max: 1,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onnotice: () => {},
    });
    try {
      const roleRows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM pg_roles WHERE rolname = 'myme_app'
      `;
      expect(roleRows[0]?.count).toBe(1);

      const grantRows = await sql<{ count: number }[]>`
        SELECT COUNT(DISTINCT table_name)::int AS count
        FROM information_schema.role_table_grants
        WHERE grantee = 'myme_app' AND table_schema = 'public'
      `;
      // At time of writing: 22 tables. Threshold (>15) is a sanity bound,
      // not a brittle exact match — tables shift as the schema evolves.
      expect(grantRows[0]?.count ?? 0).toBeGreaterThan(15);
    } finally {
      await sql.end();
    }
  });
});
