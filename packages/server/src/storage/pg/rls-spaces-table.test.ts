/**
 * Postgres RLS enforcement for the `spaces` table itself (migration 0068).
 *
 * `spaces` carried full CRUD grants to `marfa_app` with no policy, so an
 * unscoped query under the role could read or write every space row —
 * names and owner emails included. The policy keys on the primary key
 * (`id` IS the space key), so a space-bound request sees exactly one row:
 * its own.
 *
 * Two properties are checked: reads filter cross-space, and writes are
 * refused cross-space (`FOR ALL ... USING` doubles as the `WITH CHECK` on
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

/** The space store is optional on the interface; a PG test context always
 *  has one. */
function spaceStore(ctx: TestContext): NonNullable<Storage["spaces"]> {
  const spaces = ctx.storage.spaces;
  if (!spaces) throw new Error("test context has no space store");
  return spaces;
}

const dialect = process.env.DB_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe.skipIf(!isPg)("Postgres RLS — spaces table (0068)", () => {
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
    const a = `rls-spaces-a-${rand()}`;
    const b = `rls-spaces-b-${rand()}`;
    const now = new Date().toISOString();
    for (const t of [a, b]) {
      await owner(
        `INSERT INTO spaces (id, name, created_at) VALUES ($1, $2, $3)`,
        [t, `Space ${t}`, now],
      );
    }
    return [a, b];
  }

  async function asSpace<T>(
    space: string,
    fn: (tx: Parameters<Parameters<PgDb["transaction"]>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return pgDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('marfa.space_id', ${space}, true)`,
      );
      await tx.execute(sql`SET LOCAL ROLE marfa_app`);
      return fn(tx);
    });
  }

  it("hides other spaces' rows from a space-bound read", async () => {
    const [a, b] = await seedPair();
    const query = sql`SELECT id FROM spaces WHERE id IN (${a}, ${b})`;

    const seenA = await asSpace(a, async (tx) => {
      const rows = await tx.execute<{ id: string }>(query);
      return new Set(rows.map((r) => r.id));
    });
    expect(seenA.has(a)).toBe(true);
    expect(seenA.has(b)).toBe(false);

    const seenB = await asSpace(b, async (tx) => {
      const rows = await tx.execute<{ id: string }>(query);
      return new Set(rows.map((r) => r.id));
    });
    expect(seenB.has(b)).toBe(true);
    expect(seenB.has(a)).toBe(false);
  });

  it("refuses an unscoped enumeration under the role", async () => {
    const [a] = await seedPair();
    const all = await asSpace(a, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM spaces`);
      return rows.map((r) => r.id);
    });
    expect(all).toEqual([a]);
  });

  it("refuses a cross-space write", async () => {
    const [a, b] = await seedPair();
    const updated = await asSpace(a, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`UPDATE spaces SET status = 'suspended' WHERE id = ${b} RETURNING id`,
      );
      return rows.length;
    });
    expect(updated).toBe(0);

    const after = await spaceStore(ctx).get(b);
    expect(after?.status).toBe("active");
  });

  it("keeps the owner connection exempt so admin + retention paths still enumerate", async () => {
    const [a, b] = await seedPair();
    const ids = (await spaceStore(ctx).list()).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
  });
});
