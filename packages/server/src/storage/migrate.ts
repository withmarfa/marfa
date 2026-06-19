/**
 * Standalone migration runner for Drizzle Kit migrations.
 *
 * Usage from CLI: tsx src/storage/migrate.ts [--dialect pg|sqlite]
 */

import { existsSync } from "node:fs";
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
    await migrate(db, { migrationsFolder: getMigrationFolder("sqlite") });
  } finally {
    client.close();
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
