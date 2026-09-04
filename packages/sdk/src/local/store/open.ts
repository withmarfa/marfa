import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { localSchema } from "./schema.js";
import { resolveLocalMigrationsFolder } from "./migrations-folder.js";

export type LocalDb = ReturnType<typeof drizzle<typeof localSchema>>;

/**
 * Translate a filesystem path into the URL shape libsql expects.
 *
 * `:memory:` maps to the shared-cache form because an interactive write
 * transaction opens a second logical connection, and a plain in-memory
 * database gives that connection its own empty copy. The consequence is
 * that every `:memory:` store in one process is the *same* database, so
 * tests that need isolation use a temporary file — which is also the shape
 * the engine actually ships in.
 */
export function toLibsqlUrl(pathOrUrl: string): string {
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

export interface OpenDbResult {
  db: LocalDb;
  raw: Client;
  close: () => void;
}

/** Open the store's database, run its migrations forward, and hand back
 *  both the drizzle handle and the raw client. */
export async function openDatabase(path: string): Promise<OpenDbResult> {
  if (
    path !== ":memory:" &&
    !path.startsWith("file:") &&
    !path.startsWith("http") &&
    !path.startsWith("libsql:")
  ) {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const raw = createClient({ url: toLibsqlUrl(path) });
  // libsql opens a file-backed database in `delete`, so this is a request
  // rather than a restatement of the default. The engine reads the store on
  // the interactive path while the drain writes to it, and in `delete` mode
  // a writer locks every reader out for the length of its transaction.
  await raw.execute("PRAGMA journal_mode = WAL");
  await raw.execute("PRAGMA foreign_keys = ON");

  const db = drizzle(raw, { schema: localSchema });
  await migrate(db, {
    migrationsFolder: resolveLocalMigrationsFolder(import.meta.url),
  });

  return {
    db,
    raw,
    close: () => {
      raw.close();
    },
  };
}
