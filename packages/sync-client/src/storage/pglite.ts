import { PGlite } from "@electric-sql/pglite";
import { live, type LiveNamespace } from "@electric-sql/pglite/live";
import {
  electricSync,
  type SyncNamespaceObj,
} from "@electric-sql/pglite-sync";
import type { StorageOption } from "../config.js";
import { SCHEMA_V1_SQL } from "./schema.js";
import { readSchemaVersion, stampSchemaVersion } from "./meta.js";

/**
 * PGlite after the `live` and `sync` extensions are applied. Each
 * extension widens the instance with a typed namespace (`pg.live.*`,
 * `pg.sync.*`); we declare the union once so callers get type-safe
 * access without each construction site re-deriving it.
 */
export type PGliteWithSync = PGlite & {
  live: LiveNamespace;
  sync: SyncNamespaceObj;
};

/**
 * Construct a PGlite instance from a `storage` option, install the
 * required extensions, and apply the bundled schema if this is a fresh
 * (or out-of-date) database.
 *
 * Caller is responsible for closing the returned instance via
 * `pg.close()` on shutdown.
 */
export async function createPGlite(
  storage: StorageOption,
): Promise<PGliteWithSync> {
  const dataDir = resolveDataDir(storage);
  const pg = (await PGlite.create({
    dataDir,
    extensions: {
      live,
      sync: electricSync(),
    },
  })) as PGliteWithSync;

  // Apply (idempotent) bundled schema. Uses CREATE TABLE IF NOT EXISTS
  // / CREATE INDEX IF NOT EXISTS so re-running on an existing DB is
  // safe.
  await applyBundledSchema(pg);

  // Stamp the schema version once so subsequent boots can short-circuit.
  // The cost of running the bundled SQL on every boot is small but
  // non-zero, and stamping helps with observability + downgrade
  // detection.
  const current = await readSchemaVersion(pg);
  if (current === 0) {
    await stampSchemaVersion(pg);
  }
  return pg;
}

async function applyBundledSchema(pg: PGlite): Promise<void> {
  // PGlite's multi-statement runner is the appropriate primitive here
  // (the bundled SQL contains several CREATE TABLE / CREATE INDEX
  // statements separated by semicolons).
  await pg.exec(SCHEMA_V1_SQL);
}

/**
 * Translate the union `StorageOption` into PGlite's `dataDir`. PGlite
 * accepts:
 *   - `undefined` for in-memory
 *   - `idb://<name>` for IndexedDB
 *   - `<absolute-path>` for Node filesystem
 *
 * The package's `StorageOption` strings already align with these
 * conventions (`idb:<name>` and `fs:<path>`), so this is a thin
 * translator.
 */
function resolveDataDir(
  storage: StorageOption,
): string | undefined {
  if (typeof storage === "object") {
    // Caller-provided adapter: we expect they'll plumb their own
    // PGlite, so dataDir is moot. We still construct one here in the
    // simple case; advanced callers can subclass / override.
    return undefined;
  }
  if (storage === "memory") return undefined;
  if (storage.startsWith("idb:")) {
    const name = storage.slice(4);
    return `idb://${name}`;
  }
  if (storage.startsWith("fs:")) {
    return storage.slice(3);
  }
  throw new Error(
    `Invalid storage option "${storage}". Expected 'memory', 'idb:<name>', or 'fs:<path>'.`,
  );
}
