/**
 * The Postgres half of the rename that moves the top role to
 * `instance_admin` (migration 0094).
 *
 * This is the dialect the deployments run, so the statements are replayed
 * against a real Postgres rather than trusted to match the SQLite sibling.
 * Rows are created through the stores so foreign keys are satisfied
 * honestly, then forced back to the retired value with raw SQL — nothing in
 * the current build can write `admin`, which is exactly why a row holding it
 * would sit there unnoticed.
 *
 * SQLite skips the suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/pg/0094_the_top_role_is_instance_admin.sql",
  ),
  "utf8",
);

let ctx: TestContext;

beforeAll(async () => {
  if (!isPg) return;
  // `keys` wires no user store, so every case here would throw on the seed
  // rather than exercise the migration.
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  if (!isPg) return;
  await ctx.cleanup();
});

describe.skipIf(!isPg)("0094 the top role is instance_admin", () => {
  const db = () => ctx.storage.pgDb as PgDb;

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
    await db().execute(
      sql`UPDATE users SET role = ${storedRoleValue} WHERE id = ${user.id}`,
    );
    return user.id;
  };

  const seedKey = async (label: string, storedRoleValue: string) => {
    const stored = await ctx.storage.keys.create(
      {
        label,
        source: label,
        role: "member",
        default_tier: "library",
        is_platform: false,
        type_permissions: {},
      },
      randomBytes(16).toString("hex"),
    );
    await db().execute(
      sql`UPDATE api_keys SET role = ${storedRoleValue} WHERE id = ${stored.id}`,
    );
    return stored.id;
  };

  const roleOf = async (table: "users" | "api_keys", id: string) => {
    const rows = (await db().execute(
      sql.raw(`SELECT role FROM ${table} WHERE id = '${id}'`),
    )) as unknown as { role: string }[];
    return rows[0]?.role ?? "<missing row>";
  };

  /** Statement by statement, stripping comments. Two statements here, and
   *  dropping the second silently is the defect this migration is written
   *  not to repeat — so the replay must not do it either. */
  const replay = async () => {
    for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
      const s = stmt
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      if (s.length > 0) await db().execute(sql.raw(s));
    }
  };

  it("moves the retired role forward on both tables it lives on", async () => {
    // Both, in one case rather than two, because the failure being guarded
    // is a migration that covers one of them. A per-table case passes on the
    // half that was written.
    const staleUser = await seedUser("retired-role-user", "admin");
    const staleKey = await seedKey("retired-role-key", "admin");

    await replay();

    expect(await roleOf("users", staleUser)).toBe("instance_admin");
    expect(await roleOf("api_keys", staleKey)).toBe("instance_admin");
  });

  it("leaves every other role alone", async () => {
    // The permissive direction. A statement without its WHERE clause moves
    // the retired value correctly and rewrites everything else with it,
    // which the case above cannot see.
    const member = await seedUser("member-role-user-2", "member");
    const spaceAdmin = await seedUser("space-role-user-2", "space_admin");
    const memberKey = await seedKey("member-role-key-2", "member");

    await replay();

    expect(await roleOf("users", member)).toBe("member");
    expect(await roleOf("users", spaceAdmin)).toBe("space_admin");
    expect(await roleOf("api_keys", memberKey)).toBe("member");
  });

  it("is idempotent", async () => {
    const staleUser = await seedUser("idempotent-role-user-2", "admin");
    await replay();
    await replay();
    expect(await roleOf("users", staleUser)).toBe("instance_admin");
  });

  it("leaves the retired role nowhere the schema stores one", async () => {
    await seedUser("sweep-role-user-2", "admin");
    await seedKey("sweep-role-key-2", "admin");
    await replay();
    for (const table of ["users", "api_keys"]) {
      const rows = (await db().execute(
        sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE role = 'admin'`),
      )) as unknown as { n: number }[];
      expect({ table, retired: rows[0]?.n }).toEqual({ table, retired: 0 });
    }
  });
});
