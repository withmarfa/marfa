/**
 * Postgres RLS enforcement for the `tenants` table itself (migration 0068).
 *
 * `tenants` carried full CRUD grants to `marfa_app` with no policy, so an
 * unscoped query under the role could read or write every tenant row —
 * names and owner emails included. The policy keys on the primary key
 * (`id` IS the tenant key), so a tenant-bound request sees exactly one row:
 * its own.
 *
 * Two properties are checked: reads filter cross-tenant, and writes are
 * refused cross-tenant (`FOR ALL ... USING` doubles as the `WITH CHECK` on
 * INSERT / UPDATE). Plus the owner-exemption invariant that the platform
 * paths depend on — plain `ENABLE`, never `FORCE`, so the table owner can
 * still enumerate for admin routes and background retention fan-out.
 *
 * SQLite skips the suite — RLS is a Postgres-only concern.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { Storage } from "../interface.js";
import type { PgDb } from "./connection.js";

/** The tenant store is optional on the interface; a PG test context always
 *  has one. */
function tenantStore(ctx: TestContext): NonNullable<Storage["tenants"]> {
  const tenants = ctx.storage.tenants;
  if (!tenants) throw new Error("test context has no tenant store");
  return tenants;
}

const dialect = process.env.DB_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe.skipIf(!isPg)("Postgres RLS — tenants table (0068)", () => {
  let ctx: TestContext;
  let owner: (q: string, p?: unknown[]) => Promise<unknown>;
  let pgDb: PgDb;

  beforeAll(async () => {
    ctx = await createTestContext({ rlsEnforce: true });
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, p?: unknown[]) => Promise<unknown>;
      pgDb: PgDb;
    };
    owner = s.__pgClient;
    pgDb = s.pgDb;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function seedPair(): Promise<[string, string]> {
    const a = `rls-tenants-a-${rand()}`;
    const b = `rls-tenants-b-${rand()}`;
    const now = new Date().toISOString();
    for (const t of [a, b]) {
      await owner(
        `INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3)`,
        [t, `Tenant ${t}`, now],
      );
    }
    return [a, b];
  }

  async function asTenant<T>(
    tenant: string,
    fn: (tx: Parameters<Parameters<PgDb["transaction"]>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return pgDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('marfa.tenant_id', ${tenant}, true)`,
      );
      await tx.execute(sql`SET LOCAL ROLE marfa_app`);
      return fn(tx);
    });
  }

  it("hides other tenants' rows from a tenant-bound read", async () => {
    const [a, b] = await seedPair();
    const query = sql`SELECT id FROM tenants WHERE id IN (${a}, ${b})`;

    const seenA = await asTenant(a, async (tx) => {
      const rows = await tx.execute<{ id: string }>(query);
      return new Set(rows.map((r) => r.id));
    });
    expect(seenA.has(a)).toBe(true);
    expect(seenA.has(b)).toBe(false);

    const seenB = await asTenant(b, async (tx) => {
      const rows = await tx.execute<{ id: string }>(query);
      return new Set(rows.map((r) => r.id));
    });
    expect(seenB.has(b)).toBe(true);
    expect(seenB.has(a)).toBe(false);
  });

  it("refuses an unscoped enumeration under the role", async () => {
    const [a] = await seedPair();
    const all = await asTenant(a, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`SELECT id FROM tenants`,
      );
      return rows.map((r) => r.id);
    });
    expect(all).toEqual([a]);
  });

  it("refuses a cross-tenant write", async () => {
    const [a, b] = await seedPair();
    const updated = await asTenant(a, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`UPDATE tenants SET status = 'suspended' WHERE id = ${b} RETURNING id`,
      );
      return rows.length;
    });
    expect(updated).toBe(0);

    const after = await tenantStore(ctx).get(b);
    expect(after?.status).toBe("active");
  });

  it("keeps the owner connection exempt so admin + retention paths still enumerate", async () => {
    const [a, b] = await seedPair();
    const ids = (await tenantStore(ctx).list()).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
  });
});
