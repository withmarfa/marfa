import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The text dump of the database the published v0.0.90 release wrote. */
export const DUMP = join(
  import.meta.dirname,
  "..",
  "suites",
  "compliance",
  "fixtures",
  "database-v0.0.90.sql",
);

/** The salt the release generated for its keys, which a key is valid only against. */
export const KEY_SALT =
  "7cfda7f179b0d70e6efd313c6557d3373939fa041fcfd865246abbc0b87c02c7";

/** The working key v0.0.90 minted for the dump, which holds only its hash. */
export const WORKING_KEY =
  "marfa_k1_e44eeff0eb91f8df57ecbe088e4a903dde5a66a38f2e3231feeae41ebe0a477a";

/** The `source` of every item the dump holds. */
export const SOURCE = "upgrade-fixture";
export const ITEM_IDS = [
  "01f00000-0000-7000-8000-000000000001",
  "01f00000-0000-7000-8000-000000000002",
  "01f00000-0000-7000-8000-000000000003",
] as const;
export const EDGE_ID = "01f00000-0000-7000-8000-0000000000e1";
export const TYPE_ID = "user.upgrade_witness";

/** The schema version v0.0.90 wrote. */
export const OLD_SCHEMA = 3;

/**
 * Writes the dump into `sqlitePath` as the release left it: a file in
 * write-ahead mode with no log beside it. Foreign keys are off for `alter`, so
 * a row can refer to what the file does not hold. The dump writes the schema of
 * two full-text tables, which a connection refuses while it is defensive.
 */
export function loadDump(
  sqlitePath: string,
  alter?: (db: DatabaseSync) => void,
): void {
  const db = new DatabaseSync(sqlitePath, {
    defensive: false,
    enableForeignKeyConstraints: false,
  });
  try {
    db.exec(readFileSync(DUMP, "utf8"));
    db.exec("PRAGMA journal_mode = WAL");
    alter?.(db);
  } finally {
    db.close();
  }
}
