import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";
import { stampSqliteDrizzleMigrations } from "../bootstrap-stamp.js";
import { SCHEMA_SQL } from "./schema-sql.generated.js";

// Raw SQL for tables that Drizzle cannot express (FTS5 virtual tables).
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id,
  title,
  body,
  description,
  name,
  extra,
  tokenize='porter unicode61'
);
`;

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
export type RawDb = Client;

/**
 * Translate a filesystem path or `:memory:` into the URL shape libsql expects.
 *
 * - `":memory:"` becomes `"file::memory:?cache=shared"` so multiple logical
 *   connections (e.g. the writer connection an interactive transaction holds)
 *   share one in-memory database. Plain `:memory:` gives each libsql logical
 *   connection its own isolated DB, which breaks the moment a transaction
 *   opens — the tx connection sees a different empty database.
 * - File paths become `file:<path>`.
 * - Already-formed URLs (`file:`, `http://`, `https://`, `libsql://`) pass
 *   through unchanged so callers can pin to remote replicas if needed.
 */
function toLibsqlUrl(pathOrUrl: string): string {
  if (pathOrUrl === ":memory:") return "file::memory:?cache=shared";
  if (
    pathOrUrl.startsWith("file:") ||
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("libsql://")
  ) {
    return pathOrUrl;
  }
  return `file:${pathOrUrl}`;
}

/**
 * Opens a libsql connection, enables WAL mode, creates all tables
 * (idempotent), and returns both the Drizzle db and the raw libsql client.
 */
export async function createConnection(sqlitePath: string): Promise<{
  db: DrizzleDb;
  raw: RawDb;
  close: () => Promise<void>;
}> {
  // Ensure the directory exists for filesystem paths (skip for in-memory and
  // already-formed URLs).
  if (
    sqlitePath !== ":memory:" &&
    !sqlitePath.startsWith("file:") &&
    !sqlitePath.startsWith("http") &&
    !sqlitePath.startsWith("libsql:")
  ) {
    const dir = dirname(sqlitePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const client = createClient({ url: toLibsqlUrl(sqlitePath) });

  // Enable WAL for better concurrent read/write performance. PRAGMA is a
  // no-op on libsql remote URLs but harmless.
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");

  // Create tables via raw SQL (idempotent — CREATE TABLE IF NOT EXISTS).
  // SCHEMA_SQL is auto-generated from drizzle/sqlite/ migrations by
  // scripts/generate-schema-sql.ts; see that script for details.
  await client.executeMultiple(SCHEMA_SQL);
  // The remaining hand-written block is the FTS5 virtual table — Drizzle
  // Kit cannot express FTS5, so it never appears in any migration and must
  // be applied separately.
  await client.executeMultiple(CREATE_FTS);

  // FTS5 doesn't support ALTER TABLE; detect missing 'extra' column and rebuild.
  let needsFtsRebuild = false;
  try {
    await client.execute("SELECT extra FROM items_fts LIMIT 0");
  } catch {
    needsFtsRebuild = true;
  }
  if (needsFtsRebuild) {
    await client.executeMultiple("DROP TABLE IF EXISTS items_fts");
    await client.executeMultiple(CREATE_FTS);
    // Re-index all items (extra defaults to empty since we don't have type
    // context here). json() projects the stored JSONB blob back to text —
    // reading the raw column would hand JSON.parse a binary value.
    const allItems = await client.execute(
      "SELECT id, json(properties) AS properties FROM items WHERE state != 'trashed'",
    );
    for (const row of allItems.rows) {
      try {
        const id = row.id as string;
        const propertiesText = row.properties as string;
        const props = JSON.parse(propertiesText) as Record<string, unknown>;
        const title = typeof props.title === "string" ? props.title : "";
        const body = typeof props.body === "string" ? props.body : "";
        const desc =
          typeof props.description === "string" ? props.description : "";
        const name = typeof props.name === "string" ? props.name : "";
        await client.execute({
          sql: `INSERT INTO items_fts(item_id, title, body, description, name, extra)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [id, title, body, desc, name, ""],
        });
      } catch {
        // skip rows with unparseable properties
      }
    }
  }

  // Stamp Drizzle's `__drizzle_migrations` table so a follow-up
  // `pnpm migrate` against this bootstrapped DB short-circuits as a no-op.
  // Without this, migrate replays from 0000 and several DROP / ALTER
  // migrations error against tables the bootstrap shape never had.
  // Idempotent — only stamps when the table is empty.
  await stampSqliteDrizzleMigrations(client);

  const db = drizzle(client, { schema });

  return {
    db,
    raw: client,
    close: async () => {
      client.close();
    },
  };
}

export { sql };
