/**
 * Standalone migration runner for Drizzle Kit migrations.
 *
 * Migration 0010 drops the legacy relationship columns (`items.parent_id`,
 * `items.thread_id`, `metadata.about`) that PR 4's edges model replaces.
 * The app-layer backfill needs to read those columns, so we snapshot them
 * BEFORE running migrations and feed the snapshot into the post-migration
 * backfill. Once 0010 has applied on a DB, the snapshot returns empty and
 * subsequent runs are no-ops.
 *
 * Usage from CLI: tsx src/storage/migrate.ts [--dialect pg|sqlite]
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LegacyRelationshipData } from "../../scripts/backfill-edges.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getMigrationFolder(dialect: "pg" | "sqlite"): string {
  return join(__dirname, `../../drizzle/${dialect}`);
}

export async function runPgMigrations(connectionString: string): Promise<void> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;

  const snapshot = await snapshotLegacyPg(connectionString);

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: getMigrationFolder("pg") });
  } finally {
    await client.end();
  }

  if (snapshot) {
    stashSnapshotForBackfill(snapshot);
  }
}

export async function runSqliteMigrations(sqlitePath: string): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const snapshot = await snapshotLegacySqlite(sqlitePath);

  const sqlite = new Database(sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite);

  try {
    migrate(db, { migrationsFolder: getMigrationFolder("sqlite") });
  } finally {
    sqlite.close();
  }

  if (snapshot) {
    stashSnapshotForBackfill(snapshot);
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
    void (async () => {
      try {
        await runPgMigrations(url);
        console.log("Migrations complete.");
        await runBackfillEdges(dialect);
        process.exit(0);
      } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
      }
    })();
  } else {
    const path = process.env.SQLITE_PATH ?? "./data/myme.db";
    void (async () => {
      try {
        await runSqliteMigrations(path);
        console.log("Migrations complete.");
        await runBackfillEdges(dialect);
        process.exit(0);
      } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Snapshot / backfill plumbing
// ---------------------------------------------------------------------------

// Module-local stash. Populated by migration step if the pre-migration DB
// carried legacy columns; consumed by the backfill step. Cleared after use.
let pendingSnapshot: LegacyRelationshipData | null = null;

function stashSnapshotForBackfill(snapshot: LegacyRelationshipData): void {
  pendingSnapshot = snapshot;
}

function consumeSnapshot(): LegacyRelationshipData | null {
  const s = pendingSnapshot;
  pendingSnapshot = null;
  return s;
}

async function snapshotLegacyPg(
  connectionString: string,
): Promise<LegacyRelationshipData | null> {
  const postgres = (await import("postgres")).default;
  const client = postgres(connectionString, { max: 1 });
  try {
    const hasParent = await client<{ exists: number }[]>`
      SELECT 1 AS exists FROM information_schema.columns
      WHERE table_name = 'items' AND column_name = 'parent_id' LIMIT 1
    `;
    const hasThread = await client<{ exists: number }[]>`
      SELECT 1 AS exists FROM information_schema.columns
      WHERE table_name = 'items' AND column_name = 'thread_id' LIMIT 1
    `;
    const hasAbout = await client<{ exists: number }[]>`
      SELECT 1 AS exists FROM information_schema.columns
      WHERE table_name = 'metadata' AND column_name = 'about' LIMIT 1
    `;
    if (
      hasParent.length === 0 &&
      hasThread.length === 0 &&
      hasAbout.length === 0
    ) {
      return null;
    }

    const parentRows =
      hasParent.length > 0
        ? await client<
            {
              id: string;
              tenant_id: string | null;
              parent_id: string;
              created_at: string;
            }[]
          >`
            SELECT id, tenant_id, parent_id, created_at FROM items
            WHERE parent_id IS NOT NULL
          `
        : [];
    const threadRows =
      hasThread.length > 0
        ? await client<
            {
              id: string;
              tenant_id: string | null;
              thread_id: string;
              created_at: string;
            }[]
          >`
            SELECT id, tenant_id, thread_id, created_at FROM items
            WHERE thread_id IS NOT NULL
          `
        : [];
    const metaRows =
      hasAbout.length > 0
        ? await client<
            {
              item_id: string;
              about: string;
              tenant_id: string | null;
            }[]
          >`
            SELECT m.item_id, m.about, i.tenant_id
            FROM metadata m JOIN items i ON m.item_id = i.id
            WHERE m.about IS NOT NULL AND m.about != '[]'
          `
        : [];

    if (
      parentRows.length === 0 &&
      threadRows.length === 0 &&
      metaRows.length === 0
    ) {
      return null;
    }

    console.log(
      `Snapshotting legacy relationships pre-migration: ${String(parentRows.length)} parent, ${String(threadRows.length)} thread, ${String(metaRows.length)} about`,
    );

    return buildSnapshot(parentRows, threadRows, metaRows);
  } finally {
    await client.end();
  }
}

async function snapshotLegacySqlite(
  sqlitePath: string,
): Promise<LegacyRelationshipData | null> {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(sqlitePath);
  try {
    const tableInfoItems = db.prepare("PRAGMA table_info(items)").all() as {
      name: string;
    }[];
    const itemColumns = new Set(tableInfoItems.map((r) => r.name));
    const hasParent = itemColumns.has("parent_id");
    const hasThread = itemColumns.has("thread_id");

    const tableInfoMeta = db.prepare("PRAGMA table_info(metadata)").all() as {
      name: string;
    }[];
    const hasAbout = new Set(tableInfoMeta.map((r) => r.name)).has("about");

    if (!hasParent && !hasThread && !hasAbout) return null;

    const parentRows = hasParent
      ? (db
          .prepare(
            "SELECT id, tenant_id, parent_id, created_at FROM items WHERE parent_id IS NOT NULL",
          )
          .all() as {
          id: string;
          tenant_id: string | null;
          parent_id: string;
          created_at: string;
        }[])
      : [];
    const threadRows = hasThread
      ? (db
          .prepare(
            "SELECT id, tenant_id, thread_id, created_at FROM items WHERE thread_id IS NOT NULL",
          )
          .all() as {
          id: string;
          tenant_id: string | null;
          thread_id: string;
          created_at: string;
        }[])
      : [];
    const metaRows = hasAbout
      ? (db
          .prepare(
            "SELECT m.item_id, m.about, i.tenant_id FROM metadata m JOIN items i ON m.item_id = i.id WHERE m.about IS NOT NULL AND m.about != '[]'",
          )
          .all() as {
          item_id: string;
          about: string;
          tenant_id: string | null;
        }[])
      : [];

    if (
      parentRows.length === 0 &&
      threadRows.length === 0 &&
      metaRows.length === 0
    ) {
      return null;
    }

    console.log(
      `Snapshotting legacy relationships pre-migration: ${String(parentRows.length)} parent, ${String(threadRows.length)} thread, ${String(metaRows.length)} about`,
    );

    return buildSnapshot(parentRows, threadRows, metaRows);
  } finally {
    db.close();
  }
}

function buildSnapshot(
  parentRows: {
    id: string;
    tenant_id: string | null;
    parent_id: string;
    created_at: string;
  }[],
  threadRows: {
    id: string;
    tenant_id: string | null;
    thread_id: string;
    created_at: string;
  }[],
  metaRows: {
    item_id: string;
    about: string;
    tenant_id: string | null;
  }[],
): LegacyRelationshipData {
  const metadataAbout = new Map<
    string,
    { about: string[]; tenant_id: string | null }
  >();
  for (const row of metaRows) {
    let about: string[] = [];
    try {
      const parsed = JSON.parse(row.about) as unknown;
      if (Array.isArray(parsed)) {
        about = parsed.filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
      }
    } catch {
      // corrupt row — skip
    }
    if (about.length > 0) {
      metadataAbout.set(row.item_id, { about, tenant_id: row.tenant_id });
    }
  }
  return { withParent: parentRows, withThread: threadRows, metadataAbout };
}

/**
 * Post-migration backfill. Reads the stashed snapshot (captured pre-migration,
 * because 0010 drops the source columns). Idempotent — safe to re-run.
 */
async function runBackfillEdges(dialect: "pg" | "sqlite"): Promise<void> {
  const { backfillEdges } = await import("../../scripts/backfill-edges.js");
  const snapshot = consumeSnapshot();
  let storage;
  if (dialect === "pg") {
    const { createPgStorage } = await import("./pg/index.js");
    storage = await createPgStorage(process.env.DATABASE_URL ?? "");
  } else {
    const { createSqliteStorage } = await import("./sqlite/index.js");
    storage = createSqliteStorage(process.env.SQLITE_PATH ?? "./data/myme.db");
  }
  const counts = await backfillEdges(storage, snapshot ?? undefined);
  console.log(
    `backfill-edges: parent-of=${String(counts.parentOf)}  in-thread=${String(counts.inThread)}  about=${String(counts.about)}  skipped=${String(counts.skipped)}`,
  );
  await storage.close();
}
