/**
 * Schema version + type registry hash bookkeeping.
 *
 * Stored in the `_myme_schema_meta` table as opaque key/value strings.
 * Bootstrap on `client.start()` reads these and runs migrations if
 * needed.
 */
import type { PGlite } from "@electric-sql/pglite";
import { SCHEMA_VERSION } from "./schema.js";

export const META_KEYS = {
  schemaVersion: "pglite_schema_v",
  typesHash: "types_hash",
  packageVersion: "package_version",
} as const;

export async function getMetaValue(
  pg: PGlite,
  key: string,
): Promise<string | null> {
  const result = await pg.query<{ value: string }>(
    `SELECT value FROM _myme_schema_meta WHERE key = $1`,
    [key],
  );
  return result.rows[0]?.value ?? null;
}

export async function setMetaValue(
  pg: PGlite,
  key: string,
  value: string,
): Promise<void> {
  await pg.query(
    `INSERT INTO _myme_schema_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function readSchemaVersion(pg: PGlite): Promise<number> {
  const v = await getMetaValue(pg, META_KEYS.schemaVersion);
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function stampSchemaVersion(pg: PGlite): Promise<void> {
  await setMetaValue(pg, META_KEYS.schemaVersion, String(SCHEMA_VERSION));
}

export async function stampPackageVersion(
  pg: PGlite,
  version: string,
): Promise<void> {
  await setMetaValue(pg, META_KEYS.packageVersion, version);
}
