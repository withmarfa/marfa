/**
 * Bootstrap-path migration stamping.
 *
 * The server's storage layer has two parallel install paths:
 *
 * 1. **Bootstrap** — `connection.ts:SCHEMA_SQL` runs `CREATE TABLE IF NOT
 *    EXISTS ...` etc. on a fresh database. Used at server startup, in
 *    `:memory:` test contexts, and on every `pnpm dev`.
 * 2. **Migrate** — `pnpm migrate` runs Drizzle's migration runner against an
 *    existing DB, applying every entry in `drizzle/sqlite/meta/_journal.json`
 *    that hasn't been stamped in `__drizzle_migrations`.
 *
 * Both paths converge to the same target schema, but if an operator runs
 * `pnpm migrate` against a bootstrapped DB without this helper, the migration
 * runner replays `0000` → latest from scratch — and several migrations
 * (`*_drop_legacy_rel_columns`, `*_drop_dormant_rls`, `*_drop_oauth_grants`)
 * issue `DROP TABLE` / `ALTER` against tables / objects that the bootstrap
 * shape never had. Most CREATE statements are `IF NOT EXISTS`-guarded; the
 * DROP/ALTER ones are not, so the migrate run errors halfway through.
 *
 * This module stamps `__drizzle_migrations` with the same hash + folderMillis
 * that Drizzle's migrator would write, so a follow-up `pnpm migrate` finds the
 * latest entry and short-circuits as a no-op.
 *
 * Hash algorithm matches Drizzle 0.45.x:
 *   sha256(file_content_utf8) → hex
 * (verified against `node_modules/.../drizzle-orm/migrator.js`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface StampedMigration {
  hash: string;
  created_at: number;
}

/**
 * Resolve the on-disk path to `drizzle/sqlite/`. Tries dev-tree paths
 * relative to this source file first, then falls back to the package layout
 * after tsup has bundled to `dist/`.
 */
function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // src/storage/bootstrap-stamp.ts (dev via tsx)
    join(here, "../../drizzle/sqlite"),
    // dist/<bundled>.js (after `tsup` flattens src/ into dist/)
    join(here, "../drizzle/sqlite"),
    // process.cwd() — fall-back when neither relative path resolves
    // (e.g. an exotic loader that mangles import.meta.url).
    join(process.cwd(), "drizzle/sqlite"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "meta/_journal.json"))) return c;
  }
  throw new Error(
    `Cannot locate the drizzle migrations folder. Tried: ${candidates.join(", ")}`,
  );
}

/**
 * Read the journal and return one stamped migration per entry, in journal
 * order. Hash is sha256(file_content) — bytewise identical to what Drizzle's
 * migrator computes on the same file.
 */
export function readStampedMigrations(): StampedMigration[] {
  const folder = resolveMigrationsFolder();
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as Journal;
  return journal.entries.map((entry) => {
    const sql = readFileSync(join(folder, `${entry.tag}.sql`), "utf-8");
    return {
      hash: createHash("sha256").update(sql).digest("hex"),
      created_at: entry.when,
    };
  });
}

// ---------------------------------------------------------------------------
// SQLite stamping (async — libsql)
// ---------------------------------------------------------------------------

/**
 * Stamp `__drizzle_migrations` after the SCHEMA_SQL bootstrap runs. Idempotent:
 * if the table already carries any rows (i.e. `pnpm migrate` has already run
 * against this DB) this is a no-op.
 *
 * Drizzle's SQLite migrator skips a migration when
 *   `lastDbMigration.created_at >= migration.folderMillis`
 * and writes `(hash, created_at)` after each apply. We mirror that shape so a
 * follow-up `pnpm migrate` finds the latest stamp and short-circuits.
 */
export async function stampSqliteDrizzleMigrations(
  client: Client,
): Promise<void> {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL,
       created_at NUMERIC
     )`,
  );
  const existing = await client.execute(
    "SELECT COUNT(*) AS n FROM __drizzle_migrations",
  );
  const count = Number(existing.rows[0]?.n ?? 0);
  if (count > 0) return;

  const stamped = readStampedMigrations();
  for (const m of stamped) {
    await client.execute({
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      args: [m.hash, m.created_at],
    });
  }
}
