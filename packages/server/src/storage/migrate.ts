/**
 * Standalone migration runner for Drizzle Kit migrations.
 *
 * Usage from CLI: tsx src/storage/migrate.ts
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getMigrationFolder(): string {
  // Resolve relative to the running file so it works whether invoked as source
  // (`tsx src/storage/migrate.ts` → ../../drizzle) or as the built standalone
  // migrator (`node dist/migrate.js` → ../drizzle).
  const candidates = [
    join(__dirname, "../../drizzle/sqlite"),
    join(__dirname, "../drizzle/sqlite"),
  ];
  return (
    candidates.find((c) => existsSync(c)) ??
    join(__dirname, "../../drizzle/sqlite")
  );
}

interface JournalEntry {
  tag: string;
}

/**
 * A throwaway migration folder holding the chain up to and including
 * `throughTag`, and nothing after it.
 *
 * It exists so a data migration can be tested. The schema suites apply
 * every migration to an empty database and compare structure, which cannot
 * observe an `UPDATE ... WHERE` in a migration body doing anything at all —
 * there are no rows for it to touch. Testing one needs rows that predate
 * it, and that needs a way to stop the runner short of it.
 *
 * The migrator takes its list from `meta/_journal.json` inside the folder
 * it is handed, so a trimmed copy of the journal beside copies of the same
 * `.sql` files is the entire mechanism — the real runner, the real SQL, a
 * shorter list. Copied rather than trimmed in place because the real folder
 * is what every other caller reads.
 *
 * The caller owns the returned directory and must remove it.
 */
function partialMigrationFolder(throughTag: string): string {
  const source = getMigrationFolder();
  const journalPath = join(source, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  const cut = journal.entries.findIndex((e) => e.tag === throughTag);
  if (cut === -1) {
    throw new Error(`No migration tagged "${throughTag}"`);
  }
  const kept = journal.entries.slice(0, cut + 1);

  const folder = mkdtempSync(join(tmpdir(), "marfa-migrations-"));
  mkdirSync(join(folder, "meta"), { recursive: true });
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  for (const entry of kept) {
    copyFileSync(
      join(source, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  }
  return folder;
}

async function applySqliteMigrations(
  sqlitePath: string,
  migrationsFolder: string,
): Promise<void> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");

  const url =
    sqlitePath.startsWith("file:") || sqlitePath.startsWith("libsql:")
      ? sqlitePath
      : `file:${sqlitePath}`;
  const client = createClient({ url });
  await client.execute("PRAGMA journal_mode = WAL");
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder });
  } finally {
    client.close();
  }
}

export async function runSqliteMigrations(sqlitePath: string): Promise<void> {
  await applySqliteMigrations(sqlitePath, getMigrationFolder());
}

/**
 * Migrate a SQLite database up to and including `throughTag`, stopping
 * there. `partialMigrationFolder` carries why this exists.
 */
export async function runSqliteMigrationsThrough(
  sqlitePath: string,
  throughTag: string,
): Promise<void> {
  const folder = partialMigrationFolder(throughTag);
  try {
    await applySqliteMigrations(sqlitePath, folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// CLI entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") ||
    process.argv[1].endsWith("migrate.js"))
) {
  console.log("Running sqlite migrations...");
  const path = process.env.SQLITE_PATH ?? "./data/marfa.db";
  void (async () => {
    try {
      await runSqliteMigrations(path);
      console.log("Migrations complete.");
      process.exit(0);
    } catch (err) {
      console.error("Migration failed:", err);
      process.exit(1);
    }
  })();
}
