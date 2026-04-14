/**
 * Standalone migration runner for Drizzle Kit migrations.
 *
 * The server's connection modules use inline DDL (CREATE TABLE IF NOT EXISTS)
 * as the primary mechanism for schema creation. Drizzle migrations are used
 * for fresh databases (Docker) and future schema changes.
 *
 * Usage from CLI: tsx src/storage/migrate.ts [--dialect pg|sqlite]
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getMigrationFolder(dialect: "pg" | "sqlite"): string {
  return join(__dirname, `../../drizzle/${dialect}`);
}

export async function runPgMigrations(connectionString: string): Promise<void> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: getMigrationFolder("pg") });
  } finally {
    await client.end();
  }
}

export async function runSqliteMigrations(sqlitePath: string): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const sqlite = new Database(sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite);

  try {
    migrate(db, { migrationsFolder: getMigrationFolder("sqlite") });
  } finally {
    sqlite.close();
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
    : process.env.STORAGE_DIALECT === "pg"
      ? "pg"
      : "sqlite";

  console.log(`Running ${dialect} migrations...`);

  if (dialect === "pg") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL is required for Postgres migrations");
      process.exit(1);
    }
    runPgMigrations(url)
      .then(() => {
        console.log("Migrations complete.");
        process.exit(0);
      })
      .catch((err) => {
        console.error("Migration failed:", err);
        process.exit(1);
      });
  } else {
    const path = process.env.SQLITE_PATH ?? "./data/myme.db";
    try {
      runSqliteMigrations(path);
      console.log("Migrations complete.");
    } catch (err) {
      console.error("Migration failed:", err);
      process.exit(1);
    }
  }
}
