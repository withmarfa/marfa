import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the backfill that finishes the space rename on `users.role`.
 *
 * The rename migration realigned the stored role on `api_keys` and left the
 * same value on `users`, so every account holder carried a role no build
 * recognized. This is the repair, and the reason it is tested at all is that
 * the omission was invisible: nothing throws on an unknown role, it simply
 * matches no branch.
 *
 * The migration is read from the file rather than retyped, so an edit to the
 * SQL has to pass these cases too.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0079_the_space_rename_reaches_the_users_table.sql",
  ),
  "utf8",
);

async function fixture() {
  const db = createClient({ url: ":memory:" });
  await db.execute("CREATE TABLE users (id text PRIMARY KEY, role text)");
  await db.execute("CREATE TABLE api_keys (id text PRIMARY KEY, role text)");
  return db;
}

/** Statement by statement, stripping comments, exactly as the sibling
 *  migration tests do. libsql's `execute` is single-statement and silently
 *  drops trailing ones, so a file that grows a second statement must not
 *  have half of it quietly skipped here. */
async function replay(db: Awaited<ReturnType<typeof fixture>>) {
  for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
    const s = stmt
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")
      .trim();
    if (s.length > 0) await db.execute(s);
  }
}

const roles = async (db: Awaited<ReturnType<typeof fixture>>) =>
  (await db.execute("SELECT id, role FROM users ORDER BY id")).rows.map(
    (r) => `${r.id as string}:${r.role as string}`,
  );

describe("0079 the space rename reaches the users table", () => {
  it("moves a stale role forward", async () => {
    const db = await fixture();
    try {
      await db.execute("INSERT INTO users VALUES ('u1', 'tenant_admin')");
      await replay(db);
      expect(await roles(db)).toEqual(["u1:space_admin"]);
    } finally {
      db.close();
    }
  });

  it("leaves every other role alone", async () => {
    const db = await fixture();
    try {
      await db.execute("INSERT INTO users VALUES ('u1', 'member')");
      await db.execute("INSERT INTO users VALUES ('u2', 'admin')");
      await replay(db);
      expect(await roles(db)).toEqual(["u1:member", "u2:admin"]);
    } finally {
      db.close();
    }
  });

  it("leaves a row that is already correct untouched", async () => {
    const db = await fixture();
    try {
      await db.execute("INSERT INTO users VALUES ('u1', 'space_admin')");
      await replay(db);
      expect(await roles(db)).toEqual(["u1:space_admin"]);
    } finally {
      db.close();
    }
  });

  it("does not touch api_keys, which an earlier migration already moved", async () => {
    const db = await fixture();
    try {
      // Seeded stale on purpose. Seeding a row that is already correct
      // would pass whether or not someone widened the statement to both
      // tables, which is no guard at all. The rename migration already
      // moved `api_keys`; a second pass over it would be harmless today
      // and misleading forever, because it would suggest the earlier one
      // had not run.
      await db.execute("INSERT INTO api_keys VALUES ('k1', 'tenant_admin')");
      await replay(db);
      const rows = await db.execute("SELECT role FROM api_keys");
      expect(rows.rows.map((r) => r.role)).toEqual(["tenant_admin"]);
    } finally {
      db.close();
    }
  });

  it("is idempotent", async () => {
    const db = await fixture();
    try {
      await db.execute("INSERT INTO users VALUES ('u1', 'tenant_admin')");
      await replay(db);
      await replay(db);
      expect(await roles(db)).toEqual(["u1:space_admin"]);
    } finally {
      db.close();
    }
  });
});
