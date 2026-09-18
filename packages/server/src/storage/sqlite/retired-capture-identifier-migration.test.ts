import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the retirement of `withmarfa.captured_email` against the two
 * shapes an instance can be in.
 *
 * The seed is an upsert with no prune and the in-memory registry is filled
 * from the rows, so deleting the shipped JSON removes the type from a fresh
 * instance and from no existing one. The migration is the whole of the
 * retirement, which makes what it declines to do as load-bearing as what it
 * does: an instance still holding items of the identifier keeps the row,
 * because the row is what makes those items resolve.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0078_the_retired_capture_identifier_leaves_the_registry.sql",
  ),
  "utf8",
);

async function fixture() {
  const db = createClient({ url: ":memory:" });
  await db.execute("CREATE TABLE items (id text PRIMARY KEY, type text)");
  await db.execute(
    "CREATE TABLE custom_types (space_id text, id text, origin text, PRIMARY KEY (space_id, id))",
  );
  await db.execute(
    "INSERT INTO custom_types VALUES ('', 'withmarfa.captured_email', 'platform')",
  );
  await db.execute(
    "INSERT INTO custom_types VALUES ('', 'marfa.captured_email', 'platform')",
  );
  return db;
}

const remaining = async (db: Awaited<ReturnType<typeof fixture>>) =>
  (await db.execute("SELECT id FROM custom_types ORDER BY id")).rows.map(
    (r) => r.id as string,
  );

describe("0078 the retired capture identifier leaves the registry", () => {
  it("removes the row when nothing holds the identifier", async () => {
    const db = await fixture();
    try {
      await db.execute(MIGRATION);
      expect(await remaining(db)).toEqual(["marfa.captured_email"]);
    } finally {
      db.close();
    }
  });

  it("leaves the row alone when items still hold the identifier", async () => {
    const db = await fixture();
    try {
      await db.execute(
        "INSERT INTO items VALUES ('item_1', 'withmarfa.captured_email')",
      );
      await db.execute(MIGRATION);
      // Orphaning readable data to tidy a registry is the wrong trade. The
      // instance keeps a type its build no longer ships until its rows move.
      expect(await remaining(db)).toEqual([
        "marfa.captured_email",
        "withmarfa.captured_email",
      ]);
    } finally {
      db.close();
    }
  });

  it("leaves a row that is not the platform's own", async () => {
    const db = await fixture();
    try {
      await db.execute("DELETE FROM custom_types WHERE origin = 'platform'");
      await db.execute(
        "INSERT INTO custom_types VALUES ('space_1', 'withmarfa.captured_email', 'user')",
      );
      await db.execute(MIGRATION);
      expect(await remaining(db)).toEqual(["withmarfa.captured_email"]);
    } finally {
      db.close();
    }
  });

  it("is idempotent", async () => {
    const db = await fixture();
    try {
      await db.execute(MIGRATION);
      await db.execute(MIGRATION);
      expect(await remaining(db)).toEqual(["marfa.captured_email"]);
    } finally {
      db.close();
    }
  });
});
