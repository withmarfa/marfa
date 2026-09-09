/**
 * What the space-less-holds-nothing migration does to rows, on both dialects.
 *
 * The row constraint already ties a null `space_id` to `is_operator`. This
 * migration adds the other half of the model to the data: running the
 * instance is not a permission, so the tier that runs it carries none. Two
 * doors could previously write past that, and an instance may already hold
 * what they wrote.
 *
 * Nothing else in the repository can observe a body of `UPDATE ... WHERE
 * space_id IS NULL`. The schema suites apply every migration to an empty
 * database and compare structure, so a data statement is never seen touching
 * anything, and the journal test never opens a `.sql` file. The two decisions
 * worth pinning are the ones a wrong answer makes silently: the predicate has
 * to reach every space-less row rather than only the live ones, and it has to
 * leave every space-bound row exactly as it found it. Narrowing the second by
 * accident would strip a working key of everything it holds, on an instance
 * where the only symptom is that nothing works afterwards.
 *
 * Both dialects, because both carry the statement. The Postgres half needs a
 * database it can create, so it skips where the suite was not given one.
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
const TAG = {
  sqlite: "0092_a_spaceless_credential_holds_nothing",
  pg: "0106_a_spaceless_credential_holds_nothing",
} as const;

/**
 * The entry immediately before the migration, read from the journal rather
 * than spelled out again: renumbering something earlier should not need an
 * edit here, while the migration's own tag is what this test is about.
 */
function tagBefore(dialect: "pg" | "sqlite"): string {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_ROOT, dialect, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === TAG[dialect]);
  expect(at, `${TAG[dialect]} is in the ${dialect} journal`).toBeGreaterThan(0);
  return journal.entries[at - 1]!.tag;
}

const NOW = "2026-01-02T03:04:05.000Z";
const WIDE = '{"*":"write"}';
const EVERY_SPACE_PERMISSION = '["space.keys","space.item_purge"]';

/** The six columns the migration clears, and what "cleared" reads as. */
const EMPTY = {
  type_permissions: "{}",
  edge_permissions: "{}",
  metadata_permissions: "{}",
  extension_permissions: "{}",
  profile_permissions: "{}",
  space_permissions: "[]",
};

const COLUMNS = Object.keys(EMPTY).join(", ");

describe.skipIf(isPg)("the SQLite space-less-holds-nothing migration", () => {
  const workDir = mkdtempSync(join(tmpdir(), "marfa-spaceless-nothing-"));
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("clears every space-less row and leaves a space-bound one alone", async () => {
    const dbPath = join(workDir, "spaceless.db");
    await runSqliteMigrationsThrough(dbPath, tagBefore("sqlite"));
    const client = createClient({ url: `file:${dbPath}` });

    await client.execute({
      sql: `INSERT INTO spaces (id, name, created_at) VALUES ('space-a', 'A', ?)`,
      args: [NOW],
    });
    // Three rows the migration has an opinion about, and one it must not
    // touch. The maps are seeded directly because no door writes this shape
    // any more, which is the whole reason the migration exists.
    for (const [id, spaceId, isOperator, revokedAt] of [
      ["widened-operator", null, 1, null],
      ["revoked-operator", null, 1, NOW],
      ["working-key", "space-a", 0, null],
    ] as const) {
      await client.execute({
        sql: `INSERT INTO api_keys
                (id, space_id, key_hash, label, source, is_operator, created_at, revoked_at,
                 type_permissions, edge_permissions, metadata_permissions,
                 extension_permissions, profile_permissions, space_permissions)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          spaceId,
          `hash-${id}`,
          id,
          id,
          isOperator,
          NOW,
          revokedAt,
          WIDE,
          WIDE,
          WIDE,
          WIDE,
          WIDE,
          EVERY_SPACE_PERMISSION,
        ],
      });
    }

    await runSqliteMigrations(dbPath);

    for (const id of ["widened-operator", "revoked-operator"]) {
      const row = await client.execute({
        sql: `SELECT ${COLUMNS} FROM api_keys WHERE id = ?`,
        args: [id],
      });
      expect(row.rows[0], id).toMatchObject(EMPTY);
    }

    // The row the predicate must not reach. A migration that cleared this one
    // would take every permission off the credential a space actually works
    // through, and the only symptom is that nothing works afterwards.
    const kept = await client.execute(
      `SELECT ${COLUMNS} FROM api_keys WHERE id = 'working-key'`,
    );
    expect(kept.rows[0]).toMatchObject({
      type_permissions: WIDE,
      space_permissions: EVERY_SPACE_PERMISSION,
    });
  });
});

describe.skipIf(!isPg || !adminUrl)(
  "the Postgres space-less-holds-nothing migration",
  () => {
    const dbName = `marfa_spaceless_nothing_${Math.random().toString(36).slice(2, 10)}`;
    let admin: postgres.Sql | null = null;
    const created: string[] = [];

    afterAll(async () => {
      if (!admin) return;
      for (const name of created) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      await admin.end({ timeout: 5 });
    });

    /** A fresh database migrated to the statement before this one. */
    async function freshUrl(suffix: string): Promise<string> {
      admin ??= postgres(adminUrl, { max: 1, onnotice: () => undefined });
      const name = `${dbName}_${suffix}`;
      created.push(name);
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const url = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
      await runPgMigrationsThrough(url, tagBefore("pg"));
      return url;
    }

    it("clears every space-less row and leaves a space-bound one alone", async () => {
      const url = await freshUrl("clear");
      const sql = postgres(url, { max: 2, onnotice: () => undefined });
      try {
        await sql`INSERT INTO spaces (id, name, created_at) VALUES ('space-a', 'A', ${NOW})`;
        for (const [id, spaceId, isOperator, revokedAt] of [
          ["widened-operator", null, true, null],
          ["revoked-operator", null, true, NOW],
          ["working-key", "space-a", false, null],
        ] as const) {
          await sql`
            INSERT INTO api_keys
              (id, space_id, key_hash, label, source, is_operator, created_at, revoked_at,
               type_permissions, edge_permissions, metadata_permissions,
               extension_permissions, profile_permissions, space_permissions)
            VALUES (${id}, ${spaceId}, ${`hash-${id}`}, ${id}, ${id}, ${isOperator},
                    ${NOW}, ${revokedAt},
                    ${WIDE}, ${WIDE}, ${WIDE}, ${WIDE}, ${WIDE},
                    ${EVERY_SPACE_PERMISSION})
          `;
        }

        await runPgMigrations(url);

        for (const id of ["widened-operator", "revoked-operator"]) {
          const row = await sql<Record<string, string>[]>`
            SELECT type_permissions, edge_permissions, metadata_permissions,
                   extension_permissions, profile_permissions, space_permissions
            FROM api_keys WHERE id = ${id}
          `;
          expect(row[0], id).toMatchObject(EMPTY);
        }

        const kept = await sql<Record<string, string>[]>`
          SELECT type_permissions, space_permissions
          FROM api_keys WHERE id = 'working-key'
        `;
        expect(kept[0]).toMatchObject({
          type_permissions: WIDE,
          space_permissions: EVERY_SPACE_PERMISSION,
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
);
