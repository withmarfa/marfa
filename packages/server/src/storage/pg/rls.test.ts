/**
 * Postgres RLS schema scaffold.
 *
 * Verifies the migration applied: `marfa_app` role exists, RLS is enabled
 * on every tenant-scoped table, and the per-table policies are present.
 *
 * Cross-tenant denial via the actual role-on-checkout path is tested in
 * `rls-enforcement.test.ts`. SQLite skips the entire suite — RLS is a
 * Postgres-only concern.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "../../test-utils.js";

const dialect = process.env.DB_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

describe.skipIf(!isPg)("Postgres RLS scaffold", () => {
  let ctx: TestContext;
  let pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;

  beforeAll(async () => {
    ctx = await createTestContext();
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    pgClient = s.__pgClient;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("creates the marfa_app role", async () => {
    const rows = (await pgClient(
      `SELECT rolname FROM pg_roles WHERE rolname = 'marfa_app'`,
    )) as { rolname: string }[];
    expect(rows).toHaveLength(1);
  });

  const TENANT_SCOPED_TABLES = [
    "items",
    "edges",
    "versions",
    "metadata",
    "api_keys",
    "blobs",
    "custom_types",
    "custom_edge_types",
    "outbound_webhooks",
    "audit_log",
    "event_log",
  ];

  it.each(TENANT_SCOPED_TABLES)(
    "enables RLS + has tenant_isolation policy on %s",
    async (table) => {
      // RLS enabled?
      const enabled = (await pgClient(
        `SELECT relrowsecurity FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
        [table],
      )) as { relrowsecurity: boolean }[];
      expect(enabled).toHaveLength(1);
      expect(enabled[0]?.relrowsecurity).toBe(true);

      // Policy present?
      const policy = (await pgClient(
        `SELECT polname FROM pg_policy
           WHERE polrelid = (SELECT oid FROM pg_class WHERE relname = $1 AND relkind = 'r')
             AND polname = $2`,
        [table, `${table}_tenant_isolation`],
      )) as { polname: string }[];
      expect(policy).toHaveLength(1);
    },
  );

  it("grants CRUD on tenant-scoped tables to marfa_app", async () => {
    // Spot-check a couple of tables
    for (const table of ["items", "edges", "blobs"]) {
      const grants = (await pgClient(
        `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE grantee = 'marfa_app' AND table_name = $1`,
        [table],
      )) as { privilege_type: string }[];
      const types = new Set(grants.map((g) => g.privilege_type));
      expect(types).toContain("SELECT");
      expect(types).toContain("INSERT");
      expect(types).toContain("UPDATE");
      expect(types).toContain("DELETE");
    }
  });
});
