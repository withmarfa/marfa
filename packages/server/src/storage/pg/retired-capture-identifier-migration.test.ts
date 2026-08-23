/**
 * The Postgres half of retiring `withmarfa.captured_email` (migration 0092).
 *
 * This is the dialect the deployments run, so the statement is replayed
 * against a real Postgres rather than trusted to match its SQLite sibling.
 * What it declines to do is as load-bearing as what it does: an instance
 * still holding items of the identifier keeps the row, because the row is
 * what makes those items resolve, and the seed will never put it back.
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

const RETIRED = "withmarfa.captured_email";
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/pg/0092_the_retired_capture_identifier_leaves_the_registry.sql",
  ),
  "utf8",
);

let ctx: TestContext;

beforeAll(async () => {
  if (!isPg) return;
  ctx = await createTestContext();
});

afterAll(async () => {
  if (!isPg) return;
  await ctx.cleanup();
});

describe.skipIf(!isPg)(
  "0092 the retired capture identifier leaves the registry",
  () => {
    const seedType = async (db: PgDb, spaceId: string, origin: string) => {
      await db.execute(sql`
        INSERT INTO custom_types (id, space_id, schema, origin, family, owner_integration, created_at, updated_at)
        VALUES (${RETIRED}, ${spaceId}, ${JSON.stringify({ id: RETIRED, version: 1, fields: {} })}::jsonb,
                ${origin}, 'integration', NULL, now(), now())
        ON CONFLICT (space_id, id) DO UPDATE SET origin = ${origin}
      `);
    };

    const registered = async (db: PgDb, spaceId: string): Promise<boolean> => {
      const rows = await db.execute(sql`
        SELECT 1 FROM custom_types WHERE id = ${RETIRED} AND space_id = ${spaceId}
      `);
      return (rows as unknown as { length: number }).length > 0;
    };

    const clear = async (db: PgDb) => {
      await db.execute(sql`DELETE FROM custom_types WHERE id = ${RETIRED}`);
      await db.execute(sql`DELETE FROM items WHERE type = ${RETIRED}`);
    };

    it("removes the platform row when nothing holds the identifier", async () => {
      const db = ctx.storage.pgDb as PgDb;
      await clear(db);
      await seedType(db, "", "platform");
      try {
        await db.execute(sql.raw(MIGRATION));
        expect(await registered(db, "")).toBe(false);
      } finally {
        await clear(db);
      }
    });

    it("leaves the row alone when items still hold the identifier", async () => {
      const db = ctx.storage.pgDb as PgDb;
      await clear(db);
      await seedType(db, "", "platform");
      const id = `retired-capture-${String(Date.now())}`;
      await db.execute(sql`
        INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, timestamp, version, source, schema_version)
        VALUES (${id}, ${RETIRED}, 'active', 'library', '{}'::jsonb, now(), now(), now(), 1, 'test', 2)
      `);
      try {
        await db.execute(sql.raw(MIGRATION));
        // Orphaning readable data to tidy a registry is the wrong trade.
        expect(await registered(db, "")).toBe(true);
      } finally {
        await clear(db);
      }
    });

    it("leaves a row that is not the platform's own", async () => {
      const db = ctx.storage.pgDb as PgDb;
      await clear(db);
      await seedType(db, "019edb9d-0000-7000-8000-000000000001", "user");
      try {
        await db.execute(sql.raw(MIGRATION));
        expect(
          await registered(db, "019edb9d-0000-7000-8000-000000000001"),
        ).toBe(true);
      } finally {
        await clear(db);
      }
    });

    it("is idempotent", async () => {
      const db = ctx.storage.pgDb as PgDb;
      await clear(db);
      await seedType(db, "", "platform");
      try {
        await db.execute(sql.raw(MIGRATION));
        await db.execute(sql.raw(MIGRATION));
        expect(await registered(db, "")).toBe(false);
      } finally {
        await clear(db);
      }
    });
  },
);
