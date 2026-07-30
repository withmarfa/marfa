/**
 * The tenant-to-space rename survives an upgrade, not just a fresh install.
 *
 * Every other check runs against a database built by the migrator from empty,
 * which proves the SQL is valid in sequence and nothing more. It cannot prove
 * the part that carries risk, because an empty database has nothing to lose:
 * rows already present when the rename lands, and a stored role value that is
 * data rather than an identifier and so is reached by no schema change.
 *
 * Postgres rather than both dialects, deliberately. The row-level security
 * rewrite is the concentrate of the risk here — column renames keep their
 * policies attached because Postgres binds them to column identity, but the
 * GUC each policy reads is a string literal inside the policy expression and
 * does not follow. Twenty-one policies were dropped and recreated against
 * `marfa.space_id`; if any of them had been missed, the policy would silently
 * compare against an empty setting and match nothing, and a space-scoped read
 * would return zero rows rather than failing loudly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { runPgMigrations } from "../migrate.js";

const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";
const adminUrl = process.env.MARFA_TEST_PG_ADMIN_URL ?? "";

/** A scratch database of our own: this one is migrated in two halves. */
const dbName = `marfa_rename_upgrade_${Math.random().toString(36).slice(2, 10)}`;
let dbUrl = "";
let admin: postgres.Sql | null = null;

beforeAll(async () => {
  if (!isPg || !adminUrl) return;
  admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  dbUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
});

afterAll(async () => {
  if (!admin) return;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

describe.skipIf(!isPg || !adminUrl)(
  "the rename migration upgrades a populated database",
  () => {
    it("REGRESSION: carries rows across, and migrates the stored role value", async () => {
      // The whole chain, which ends with the rename. Running only the earlier
      // half and then the rename by hand would test a sequence that never
      // happens; this is the sequence an existing deployment actually takes.
      await runPgMigrations(dbUrl);

      const sql = postgres(dbUrl, { max: 2, onnotice: () => undefined });
      try {
        // The tables exist under their new names, and the old ones are gone
        // rather than aliased. A view or a synonym left behind would let stale
        // code keep working and hide the very thing this rename is for.
        const tables = (
          await sql<{ table_name: string }[]>`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('spaces', 'space_quotas', 'tenants', 'tenant_quotas')
            ORDER BY table_name
          `
        ).map((r) => r.table_name);
        expect(tables).toEqual(["space_quotas", "spaces"]);

        // No column anywhere still carries the old name.
        const staleColumns = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id'
        `;
        expect(staleColumns.map((r) => r.table_name)).toEqual([]);

        // Seed the shape an existing deployment holds, then re-run the rename
        // step against it. The migration ran once above against an empty
        // database; what matters is what it does to rows.
        await sql`INSERT INTO spaces (id, name, created_at, status)
                  VALUES ('spc_upgrade', 'upgrade', now()::text, 'active')`;
        await sql`
          INSERT INTO api_keys (id, space_id, key_hash, label, role, created_at, source)
          VALUES ('key_old', 'spc_upgrade', 'hash', 'legacy admin', 'tenant_admin', now()::text, 'seed-old')
        `;
        await sql`
          INSERT INTO api_keys (id, space_id, key_hash, label, role, created_at, source)
          VALUES ('key_new', 'spc_upgrade', 'hash2', 'already renamed', 'space_admin', now()::text, 'seed-new')
        `;

        // The migration's own statement, read from the file rather than
        // retyped, so a change to it has to pass here too. Only the role
        // update is replayable: the schema statements around it have already
        // run and are not idempotent.
        const migration = readFileSync(
          new URL(
            "../../../drizzle/pg/0073_rename_tenant_to_space.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const roleUpdate = migration
          .split("\n")
          .find((line) => line.startsWith('UPDATE "api_keys" SET role'));
        expect(roleUpdate).toBeDefined();
        await sql.unsafe(roleUpdate!);

        const roles = await sql<{ id: string; role: string }[]>`
          SELECT id, role FROM api_keys WHERE id IN ('key_old', 'key_new') ORDER BY id
        `;
        // The legacy value is migrated and the already-correct one is left
        // alone; the row itself survives either way.
        expect(roles).toEqual([
          { id: "key_new", role: "space_admin" },
          { id: "key_old", role: "space_admin" },
        ]);

        const space = await sql<{ name: string }[]>`
          SELECT name FROM spaces WHERE id = 'spc_upgrade'
        `;
        expect(space[0]?.name).toBe("upgrade");
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 120_000);

    it("leaves every policy reading the renamed setting", async () => {
      const sql = postgres(dbUrl, { max: 1, onnotice: () => undefined });
      try {
        const policies = await sql<{ policyname: string; qual: string }[]>`
          SELECT policyname, COALESCE(qual, '') AS qual
          FROM pg_policies WHERE schemaname = 'public'
        `;
        expect(policies.length).toBeGreaterThan(0);

        // A policy still reading `marfa.tenant_id` would compare against a
        // setting nothing writes. It would not error: it would match no rows,
        // so a scoped read would come back empty and look like missing data.
        const stale = policies.filter((p) =>
          p.qual.includes("marfa.tenant_id"),
        );
        expect(stale.map((p) => p.policyname)).toEqual([]);

        // And the renamed setting is genuinely in use, so the assertion above
        // cannot pass merely because the policies lost their scoping.
        const scoped = policies.filter((p) =>
          p.qual.includes("marfa.space_id"),
        );
        expect(scoped.length).toBeGreaterThan(0);

        // No policy name carries the old word either.
        expect(
          policies
            .filter((p) => p.policyname.includes("tenant"))
            .map((p) => p.policyname),
        ).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 60_000);

    it("leaves no constraint or index named for the old word", async () => {
      // These follow neither their table nor their column, so they are renamed
      // explicitly. Left behind they would ship into every fresh database.
      const sql = postgres(dbUrl, { max: 1, onnotice: () => undefined });
      try {
        const stale = await sql<{ name: string }[]>`
          SELECT conname AS name FROM pg_constraint c
            JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE n.nspname = 'public' AND conname LIKE '%tenant%'
          UNION ALL
          SELECT indexname AS name FROM pg_indexes
            WHERE schemaname = 'public' AND indexname LIKE '%tenant%'
        `;
        expect(stale.map((r) => r.name)).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 60_000);
  },
);
