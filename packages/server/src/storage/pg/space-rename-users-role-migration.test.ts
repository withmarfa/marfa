/**
 * The Postgres half of the backfill that finishes the space rename on
 * `users.role` (migration 0093).
 *
 * This is the dialect the deployments run, so the statement is replayed
 * against a real Postgres rather than trusted to match its SQLite sibling.
 * Rows are created through the store so the table's foreign keys are
 * satisfied honestly, then forced back to the stale value with raw SQL —
 * nothing in the current build can write `tenant_admin`, which is the whole
 * reason the stale rows could sit there unnoticed.
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
    "../../../drizzle/pg/0093_the_space_rename_reaches_the_users_table.sql",
  ),
  "utf8",
);

let ctx: TestContext;

beforeAll(async () => {
  if (!isPg) return;
  // `keys` is the default, and it wires no user store at all, so every
  // case here would throw on the seed rather than exercise the migration.
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  if (!isPg) return;
  await ctx.cleanup();
});

describe.skipIf(!isPg)("0093 the space rename reaches the users table", () => {
  /** Creates a user through the store, then forces `role` to whatever the
   *  case under test needs. `role` is typed to the union everywhere it can
   *  be reached from TypeScript, so the stale value only goes in raw. */
  const seedUser = async (handle: string, storedRoleValue: string) => {
    if (!ctx.storage.spaces || !ctx.storage.users) {
      throw new Error("hosted storage expected");
    }
    const space = await ctx.storage.spaces.create(handle);
    const user = await ctx.storage.users.create({
      name: handle,
      provider: "test",
      provider_id: `${handle}-provider-id`,
      space_id: space.id,
      handle,
      auth_user_id: `${handle}-auth-user`,
    });
    const db = ctx.storage.pgDb as PgDb;
    await db.execute(
      sql`UPDATE users SET role = ${storedRoleValue} WHERE id = ${user.id}`,
    );
    return user.id;
  };

  const storedRoleOf = async (id: string): Promise<string> => {
    const db = ctx.storage.pgDb as PgDb;
    const rows = (await db.execute(
      sql`SELECT role FROM users WHERE id = ${id}`,
    )) as unknown as { role: string }[];
    return rows[0]?.role ?? "<missing row>";
  };

  /** Statement by statement, stripping comments, exactly as the sibling
   *  migration tests do. One statement today, but a file that grows a
   *  second one must not have it silently dropped here. */
  const replay = async () => {
    const db = ctx.storage.pgDb as PgDb;
    for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
      const s = stmt
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      if (s.length > 0) await db.execute(sql.raw(s));
    }
  };

  it("moves a stale role forward and leaves the others alone", async () => {
    const stale = await seedUser("stale-role-user", "tenant_admin");
    const member = await seedUser("member-role-user", "member");
    const admin = await seedUser("admin-role-user", "admin");
    const already = await seedUser("correct-role-user", "space_admin");

    await replay();

    expect(await storedRoleOf(stale)).toBe("space_admin");
    expect(await storedRoleOf(member)).toBe("member");
    expect(await storedRoleOf(admin)).toBe("admin");
    expect(await storedRoleOf(already)).toBe("space_admin");
  });

  it("is idempotent", async () => {
    const stale = await seedUser("idempotent-role-user", "tenant_admin");
    await replay();
    await replay();
    expect(await storedRoleOf(stale)).toBe("space_admin");
  });

  it("leaves no stale role anywhere the schema stores one", async () => {
    // The defect was a migration that covered one of the two tables holding
    // this value. Asserting across both is the check that would have caught
    // it, and it keeps catching it if a third table ever grows a role.
    await seedUser("sweep-role-user", "tenant_admin");
    await replay();
    const db = ctx.storage.pgDb as PgDb;
    for (const table of ["users", "api_keys"]) {
      const rows = (await db.execute(
        sql.raw(
          `SELECT count(*)::int AS n FROM ${table} WHERE role = 'tenant_admin'`,
        ),
      )) as unknown as { n: number }[];
      expect({ table, stale: rows[0]?.n }).toEqual({ table, stale: 0 });
    }
  });
});
