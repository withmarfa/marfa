/**
 * Standalone migration runner for Drizzle Kit migrations.
 *
 * Usage from CLI: tsx src/storage/migrate.ts [--dialect pg|sqlite]
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

export function getMigrationFolder(dialect: "pg" | "sqlite"): string {
  // Resolve relative to the running file so it works whether invoked as source
  // (`tsx src/storage/migrate.ts` → ../../drizzle, used by the hosted deploy)
  // or as the built standalone migrator (`node dist/migrate.js` → ../drizzle,
  // used by the docker-compose self-host path).
  const candidates = [
    join(__dirname, `../../drizzle/${dialect}`),
    join(__dirname, `../drizzle/${dialect}`),
  ];
  return (
    candidates.find((c) => existsSync(c)) ??
    join(__dirname, `../../drizzle/${dialect}`)
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
function partialMigrationFolder(
  dialect: "pg" | "sqlite",
  throughTag: string,
): string {
  const source = getMigrationFolder(dialect);
  const journalPath = join(source, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  const cut = journal.entries.findIndex((e) => e.tag === throughTag);
  if (cut === -1) {
    throw new Error(`No ${dialect} migration tagged "${throughTag}"`);
  }
  const kept = journal.entries.slice(0, cut + 1);

  const folder = mkdtempSync(join(tmpdir(), `marfa-migrations-${dialect}-`));
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

async function applyPgMigrations(
  connectionString: string,
  migrationsFolder: string,
): Promise<void> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}

export async function runPgMigrations(connectionString: string): Promise<void> {
  await applyPgMigrations(connectionString, getMigrationFolder("pg"));
}

/**
 * Migrate a Postgres database up to and including `throughTag`, stopping
 * there. `partialMigrationFolder` carries why this exists.
 */
export async function runPgMigrationsThrough(
  connectionString: string,
  throughTag: string,
): Promise<void> {
  const folder = partialMigrationFolder("pg", throughTag);
  try {
    await applyPgMigrations(connectionString, folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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
  await applySqliteMigrations(sqlitePath, getMigrationFolder("sqlite"));
}

/**
 * Migrate a SQLite database up to and including `throughTag`, stopping
 * there. `partialMigrationFolder` carries why this exists.
 */
export async function runSqliteMigrationsThrough(
  sqlitePath: string,
  throughTag: string,
): Promise<void> {
  const folder = partialMigrationFolder("sqlite", throughTag);
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
  const dialect = process.argv.includes("--dialect")
    ? (process.argv[process.argv.indexOf("--dialect") + 1] as "pg" | "sqlite")
    : process.env.DB_DIALECT === "pg"
      ? "pg"
      : "sqlite";

  console.log(`Running ${dialect} migrations...`);

  if (dialect === "pg") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL is required for Postgres migrations");
      process.exit(1);
    }
    void (async () => {
      try {
        await runPgMigrations(url);
        console.log("Migrations complete.");
        process.exit(0);
      } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
      }
    })();
  } else {
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
}
