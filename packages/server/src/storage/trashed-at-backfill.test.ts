/**
 * The backfill moves no row's purge date, and it touches only rows in the
 * bin.
 *
 * Both halves are claims the migration makes about rows, and nothing else
 * in the repository is in a position to check either. The schema suites
 * apply every migration to an empty database and compare structure, so the
 * `UPDATE ... WHERE state = 'trashed'` is never observed doing anything —
 * there are no rows for it to touch. The journal test reads stamps and
 * never opens a `.sql` body. A backfill that stamped nothing, or that
 * stamped `created_at`, or that swept archived and revoked rows in beside
 * the trashed ones, is green under all of it.
 *
 * What makes each claim matter: `trashed_at` is what the retention sweep
 * now reads, so a row stamped with the wrong time is a row purged on the
 * wrong day, and a state that soft-deletes to `revoked` rather than
 * `trashed` has no retention window at all — inventing one for it stores a
 * time that means nothing and would become load-bearing the moment a sweep
 * over `revoked` is added.
 *
 * Both dialects, because both carry the statement and only the quoting
 * differs. The Postgres half needs a database it can create, so it skips
 * where the suite was not given one, exactly as the rename upgrade test
 * does.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import postgres from "postgres";
import {
  runPgMigrations,
  runPgMigrationsThrough,
  runSqliteMigrations,
  runSqliteMigrationsThrough,
} from "./migrate.js";

const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";
const adminUrl = process.env.MARFA_TEST_PG_ADMIN_URL ?? "";

const DRIZZLE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

/** The migration under test, per dialect. */
const BACKFILL_TAG = {
  sqlite: "0086_items_trashed_at",
  pg: "0100_items_trashed_at",
} as const;

/**
 * The entry immediately before the backfill, read from the journal rather
 * than spelled out again — renumbering an earlier migration should not
 * need an edit here, while the backfill's own tag is the thing this test
 * is about and is named deliberately.
 */
function tagBefore(dialect: "pg" | "sqlite"): string {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_ROOT, dialect, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === BACKFILL_TAG[dialect]);
  expect(
    at,
    `${BACKFILL_TAG[dialect]} is in the ${dialect} journal`,
  ).toBeGreaterThan(0);
  return journal.entries[at - 1]!.tag;
}

/**
 * A modification time chosen by us, so "did the stamp take it" is
 * answerable — and three distinct values, so it is answerable about this
 * column rather than about any timestamp on the row. Every column here is
 * a plausible thing for a backfill to have reached for, and with one
 * shared value each wrong choice would be indistinguishable from the
 * right one.
 */
const CHOSEN = "2026-01-02T03:04:05.000Z";
const CREATED = "2025-11-11T11:11:11.000Z";
const TIMESTAMP = "2025-07-07T07:07:07.000Z";

/**
 * One row per state the column has an opinion about. `trashed` is the only
 * one the sweep considers and the only one the backfill may stamp.
 */
const SEEDED = [
  { id: "backfill-trashed", state: "trashed", stamped: true },
  { id: "backfill-active", state: "active", stamped: false },
  { id: "backfill-archived", state: "archived", stamped: false },
  { id: "backfill-revoked", state: "revoked", stamped: false },
] as const;

describe.skipIf(isPg)("the SQLite backfill", () => {
  const workDir = mkdtempSync(join(tmpdir(), "marfa-trashed-at-backfill-"));
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("takes the modification time for trashed rows and leaves the rest null", async () => {
    const dbPath = join(workDir, "backfill.db");

    // Everything up to but not including the backfill, so the rows below
    // are rows that predate it — which is the only shape that can observe
    // what it does.
    await runSqliteMigrationsThrough(dbPath, tagBefore("sqlite"));

    const client = createClient({ url: `file:${dbPath}` });
    try {
      const columnsBefore = await client.execute(
        "SELECT name FROM pragma_table_info('items')",
      );
      // The premise: the column is not there yet. Without this the test
      // would still pass against a chain that had already applied it.
      expect(columnsBefore.rows.map((r) => r.name as string)).not.toContain(
        "trashed_at",
      );

      for (const row of SEEDED) {
        await client.execute({
          sql: `INSERT INTO items
                  (id, type, state, properties, created_at, updated_at, timestamp)
                VALUES (?, 'core.note', ?, '{}', ?, ?, ?)`,
          args: [row.id, row.state, CREATED, CHOSEN, TIMESTAMP],
        });
      }

      await runSqliteMigrations(dbPath);

      const after = await client.execute(
        "SELECT id, state, trashed_at, updated_at FROM items ORDER BY id",
      );
      const byId = new Map(
        after.rows.map((r) => [
          r.id as string,
          {
            trashed_at: r.trashed_at as string | null,
            updated_at: r.updated_at as string,
          },
        ]),
      );
      expect(byId.size).toBe(SEEDED.length);

      for (const row of SEEDED) {
        const got = byId.get(row.id);
        expect(got, row.id).toBeDefined();
        // Equal to the modification time on a trashed row, which is what
        // the sweep was reading for it — so the row's purge date is where
        // it was the day before this landed.
        expect(got!.trashed_at, `${row.id} (${row.state})`).toBe(
          row.stamped ? CHOSEN : null,
        );
        // And the migration writes the new column only.
        expect(got!.updated_at, row.id).toBe(CHOSEN);
      }
    } finally {
      client.close();
    }
  });
});

describe.skipIf(!isPg || !adminUrl)("the Postgres backfill", () => {
  const dbName = `marfa_trashed_at_backfill_${Math.random().toString(36).slice(2, 10)}`;
  let admin: postgres.Sql | null = null;

  afterAll(async () => {
    if (!admin) return;
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("takes the modification time for trashed rows and leaves the rest null", async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const dbUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

    await runPgMigrationsThrough(dbUrl, tagBefore("pg"));

    const sql = postgres(dbUrl, { max: 2, onnotice: () => undefined });
    try {
      const columnsBefore = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'items'
      `;
      expect(columnsBefore.map((r) => r.column_name)).not.toContain(
        "trashed_at",
      );

      for (const row of SEEDED) {
        await sql`
          INSERT INTO items
            (id, type, state, properties, created_at, updated_at, timestamp)
          VALUES (${row.id}, 'core.note', ${row.state}, '{}'::jsonb,
                  ${CREATED}, ${CHOSEN}, ${TIMESTAMP})
        `;
      }

      await runPgMigrations(dbUrl);

      const after = await sql<
        { id: string; trashed_at: string | null; updated_at: string }[]
      >`SELECT id, trashed_at, updated_at FROM items ORDER BY id`;
      const byId = new Map(after.map((r) => [r.id, r]));
      expect(byId.size).toBe(SEEDED.length);

      for (const row of SEEDED) {
        const got = byId.get(row.id);
        expect(got, row.id).toBeDefined();
        expect(got!.trashed_at, `${row.id} (${row.state})`).toBe(
          row.stamped ? CHOSEN : null,
        );
        expect(got!.updated_at, row.id).toBe(CHOSEN);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
