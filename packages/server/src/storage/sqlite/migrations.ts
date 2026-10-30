import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createClient, type Client, type Transaction } from "@libsql/client";
import { lucideIconId } from "@withmarfa/shared";
import * as clock from "../../clock.js";
import { errorMessage } from "../../error-text.js";
import { log } from "../../middleware/logger.js";
import { RefusedDatabaseError } from "./refused-database.js";
import {
  currentShape,
  ownTables,
  presentTables,
  rowCounts,
  schemaDifferences,
  shapeOf,
  tablesOfOtherShapes,
  type Reader,
  type Shape,
} from "./schema-shape.js";

/** What a migration writes through: the transaction it runs in. */
export interface Writer extends Reader {
  executeMultiple(sql: string): Promise<void>;
}

/**
 * One step from a schema version to the next.
 *
 * A migration ends with the DDL text `schema.sql` would have made, since the
 * check after it compares the text SQLite stored. `ALTER TABLE` rewrites
 * that text, so a changed table is made anew under its own name from the
 * statement in `schema.sql`, with its rows copied through a table of
 * another name, and never renamed into place.
 */
export interface Migration {
  /** The version the step produces, one more than the version before it. */
  to: number;
  /**
   * The tables whose rows the step may add, change or remove. Every other
   * table the earlier version declares keeps its row count, or the step is
   * rolled back.
   */
  changes: readonly string[];
  apply(db: Writer): Promise<void>;
}

/** The oldest version this build updates, held in `schema-1.sql`. */
export const BASELINE_VERSION = 1;

const BASELINE_SQL = readFileSync(
  new URL("./schema-1.sql", import.meta.url),
  "utf8",
);

export const MIGRATIONS: readonly Migration[] = [
  {
    to: 2,
    changes: ["type_icons"],
    apply: (db) =>
      db.executeMultiple(
        "CREATE TABLE `type_icons` (\n" +
          "\t`type_id` text PRIMARY KEY NOT NULL,\n" +
          "\t`icon` text NOT NULL,\n" +
          "\t`updated_at` text NOT NULL,\n" +
          "\tFOREIGN KEY (`type_id`) REFERENCES `types`(`id`) ON UPDATE no action ON DELETE cascade\n" +
          ");",
      ),
  },
  { to: 3, changes: ["types", "type_icons"], apply: iconsAsIconifyIds },
];

/**
 * Stores every type icon as an Iconify ID, `<set>:<name>`. A bare name, held
 * as an owner's icon or in a definition's `display_hints.icon`, becomes
 * `lucide:<name>` where the pinned Lucide set has it, or `lucide:<icon>` for
 * the icon Lucide renamed it to; where it has neither, the owner's icon or
 * the hint is removed, since no app can draw it. A value with a colon is
 * already an ID and is left.
 */
async function iconsAsIconifyIds(db: Writer): Promise<void> {
  const owned = await db.execute("SELECT type_id, icon FROM type_icons");
  for (const row of owned.rows) {
    const icon = row.icon as string;
    if (icon.includes(":")) continue;
    const id = lucideIconId(icon);
    await db.execute(
      id === undefined
        ? {
            sql: "DELETE FROM type_icons WHERE type_id = ?",
            args: [row.type_id as string],
          }
        : {
            sql: "UPDATE type_icons SET icon = ? WHERE type_id = ?",
            args: [id, row.type_id as string],
          },
    );
  }

  const defined = await db.execute(
    "SELECT id, schema FROM types WHERE json_valid(schema) AND json_type(schema, '$.display_hints.icon') = 'text'",
  );
  for (const row of defined.rows) {
    const schema = JSON.parse(row.schema as string) as {
      display_hints: Record<string, unknown>;
    };
    const icon = String(schema.display_hints.icon);
    if (icon.includes(":")) continue;
    const id = lucideIconId(icon);
    if (id !== undefined) schema.display_hints.icon = id;
    else {
      delete schema.display_hints.icon;
      if (Object.keys(schema.display_hints).length === 0) {
        delete (schema as { display_hints?: unknown }).display_hints;
      }
    }
    await db.execute({
      sql: "UPDATE types SET schema = ? WHERE id = ?",
      args: [JSON.stringify(schema), row.id as string],
    });
  }
}

/** The schema version this build writes, held in `PRAGMA user_version`. */
export const SCHEMA_VERSION = BASELINE_VERSION + MIGRATIONS.length;

/**
 * The versions a database that holds no version can be at: those of the
 * builds before any build stamped one. Every later build stamps the file it
 * writes, so no unstamped file is at a later version, and a migration that
 * changes only rows cannot make two of these look alike.
 */
export const UNSTAMPED_VERSIONS: readonly number[] = [1, 2];

const replayed = new Map<number, Promise<Shape>>();

/** The shape of `version`, the baseline with every migration up to it applied. */
export function replayedShape(
  version: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<Shape> {
  const build = () =>
    shapeOf(async (db) => {
      await db.executeMultiple(BASELINE_SQL);
      for (const migration of migrations) {
        if (migration.to > version) break;
        await migration.apply(db);
      }
    });
  if (migrations !== MIGRATIONS) return build();
  let shape = replayed.get(version);
  if (!shape) {
    shape = build();
    replayed.set(version, shape);
  }
  return shape;
}

/** The shape a database at `version` holds: this build's own for its version. */
export function shapeAt(version: number): Promise<Shape> {
  return version === SCHEMA_VERSION ? currentShape() : replayedShape(version);
}

/**
 * How the database differs from the shape of `version`, as
 * `schemaDifferences` says, and also every table it holds that another
 * version declares and `version` does not.
 */
export async function versionDifferences(
  db: Reader,
  version: number,
): Promise<{ differences: string[]; missingTables: string[] }> {
  const shape = await shapeAt(version);
  const found = await schemaDifferences(db, shape);
  const others: Shape[] = [];
  for (let other = BASELINE_VERSION; other <= SCHEMA_VERSION; other++) {
    if (other !== version) others.push(await shapeAt(other));
  }
  for (const name of await tablesOfOtherShapes(db, shape, others)) {
    found.differences.push(
      `the file has the ${name} table, which schema version ${String(version)} does not`,
    );
  }
  return found;
}

export async function readSchemaVersion(db: Reader): Promise<number> {
  const result = await db.execute("PRAGMA user_version");
  return Number(result.rows[0]?.user_version ?? 0);
}

/** A failure a conformance harness asks a migration for (`MARFA_TEST_MIGRATION_FAULT`). */
export type MigrationFault = "hold" | "lose-row" | "change-shape";

export interface MigrationHooks {
  fault?: MigrationFault;
  /** Free bytes to assume beside the database in place of the volume's own. */
  freeDiskBytes?: number;
  /** How long to wait for another process's write lock, in milliseconds. */
  busyTimeoutMs?: number;
}

/**
 * Another process may hold the write lock for a moment, as a replication
 * sidecar does, and nothing waits on this start yet.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 10_000;

export interface MigrationOutcome {
  from: number;
  to: number;
  backupPath: string;
}

/** Bytes the database and its log take on disk. */
function databaseBytes(path: string): number {
  let bytes = statSync(path).size;
  if (existsSync(`${path}-wal`)) bytes += statSync(`${path}-wal`).size;
  return bytes;
}

function freeBytes(path: string, hooks: MigrationHooks): number {
  if (hooks.freeDiskBytes !== undefined) return hooks.freeDiskBytes;
  const stats = statfsSync(dirname(path));
  return stats.bavail * stats.bsize;
}

/** `20261027T101500123Z`: sortable, and safe in a file name everywhere. */
function stamp(): string {
  return clock.now().toISOString().replaceAll(/[-:.]/g, "");
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * A consistent copy of the database beside it, taken before anything is
 * changed, and kept: nothing here overwrites or removes one.
 *
 * `VACUUM INTO` reads one snapshot, the log included, but neither syncs what
 * it writes nor stops a crash from leaving part of a file, so the copy is
 * written under a name that says it is unfinished, synced, checked, and only
 * then given its own name.
 */
async function takeBackup(
  client: Client,
  path: string,
  from: number,
  to: number,
  tables: readonly string[],
): Promise<{ backupPath: string; counts: Map<string, number> }> {
  const backupPath = join(
    dirname(path),
    `${basename(path)}.backup-schema-${String(from)}-to-${String(to)}-${stamp()}`,
  );
  const partial = `${backupPath}.partial`;
  if (existsSync(backupPath) || existsSync(partial)) {
    throw new Error(`${backupPath} already exists`);
  }
  await client.execute({ sql: "VACUUM INTO ?", args: [partial] });
  syncPath(partial);
  const copy = createClient({ url: `file:${partial}` });
  let counts: Map<string, number>;
  try {
    const check = await copy.execute("PRAGMA quick_check");
    const verdict = check.rows.map((row) => row.quick_check as string);
    if (verdict.length !== 1 || verdict[0] !== "ok") {
      throw new Error(`the copy fails its check: ${verdict.join("; ")}`);
    }
    counts = await rowCounts(copy, tables);
  } finally {
    copy.close();
  }
  if (existsSync(backupPath)) throw new Error(`${backupPath} already exists`);
  renameSync(partial, backupPath);
  syncPath(dirname(backupPath));
  return { backupPath, counts };
}

/** The faults a harness asks for, made inside the migration's transaction. */
async function injectFault(
  db: Writer,
  fault: MigrationFault | undefined,
  kept: readonly string[],
): Promise<void> {
  if (fault === "change-shape") {
    await db.execute("ALTER TABLE `settings` ADD COLUMN `stray` text");
  } else if (fault === "lose-row") {
    for (const table of kept) {
      const quoted = `\`${table.replaceAll("`", "``")}\``;
      const done = await db.execute(
        `DELETE FROM ${quoted} WHERE rowid = (SELECT min(rowid) FROM ${quoted})`,
      );
      if (done.rowsAffected > 0) return;
    }
  } else if (fault === "hold") {
    log(
      "warn",
      "Holding the database update open before it commits, as MARFA_TEST_MIGRATION_FAULT asks",
    );
    await new Promise<never>(() => {
      setInterval(() => undefined, 60_000);
    });
  }
}

async function brokenReferences(db: Reader): Promise<number> {
  return (await db.execute("PRAGMA foreign_key_check")).rows.length;
}

function describeCounts(
  before: Map<string, number>,
  after: Map<string, number>,
): string[] {
  const out: string[] = [];
  for (const [table, count] of before) {
    const now = after.get(table);
    if (now !== count) {
      out.push(
        `the ${table} table held ${String(count)} rows and would hold ${String(now ?? 0)}`,
      );
    }
  }
  return out;
}

/**
 * Brings the database at `path` from schema version `from` to this build's,
 * in one transaction, after a copy of it is taken beside it.
 *
 * Nothing is committed unless every table the steps do not name holds as
 * many rows as before, the schema is exactly this build's, and no more rows
 * refer to missing rows than before; otherwise the transaction is rolled
 * back, the file stays as it was found, and the start is refused naming the
 * copy.
 *
 * The steps run on a connection of their own with foreign keys off, because
 * with them on a `DROP TABLE` deletes its rows first and the deletion
 * cascades into every table that refers to it.
 */
export async function migrateInPlace(
  path: string,
  from: number,
  hooks: MigrationHooks = {},
  migrations: readonly Migration[] = MIGRATIONS,
  target: Promise<Shape> = currentShape(),
): Promise<MigrationOutcome> {
  const to = migrations.at(-1)?.to ?? from;
  const pending = migrations.filter((migration) => migration.to > from);
  const before = await (migrations === MIGRATIONS
    ? shapeAt(from)
    : replayedShape(from, migrations));
  const changed = new Set(pending.flatMap((migration) => migration.changes));
  const steps = `from schema version ${String(from)} to ${String(to)}`;

  const size = databaseBytes(path);
  const need = 2 * size;
  const free = freeBytes(path, hooks);
  if (free < need) {
    throw new RefusedDatabaseError(
      `The database in ${path} is at schema version ${String(from)} and this build updates it to ${String(to)}, ` +
        `which needs ${String(need)} bytes free beside it, twice the database's size, for a copy of it and for the update, ` +
        `and ${String(free)} are free. Nothing was changed. Free some space and start again; ` +
        `the build that wrote the file still reads it.`,
    );
  }

  const client = createClient({ url: `file:${path}` });
  let backupPath: string | undefined;
  let tx: Transaction | undefined;
  let problems: string[];
  try {
    try {
      // The full-text table is applied apart from the rest, so a file can lack
      // it and still hold every other table its version declares.
      const tables = await presentTables(client, ownTables(before));
      const kept = tables.filter((table) => !changed.has(table));
      await client.execute("PRAGMA foreign_keys = OFF");
      await client.execute(
        `PRAGMA busy_timeout = ${String(hooks.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`,
      );
      const backup = await takeBackup(client, path, from, to, tables);
      backupPath = backup.backupPath;
      log(
        "info",
        `Updating the database in ${path} ${steps}. A copy of it as it was is at ${backupPath}.`,
        { schema_from: from, schema_to: to, backup_path: backupPath },
      );

      tx = await client.transaction("write");
      const counted = await rowCounts(tx, tables);
      problems = describeCounts(backup.counts, counted).map(
        (problem) => `${problem} in the copy`,
      );
      if (problems.length === 0) {
        // Compared, not required to be none: a reference a file already held
        // broken is the owner's data, and refusing it would refuse the update
        // for good.
        const brokenBefore = await brokenReferences(tx);
        for (const migration of pending) await migration.apply(tx);
        await injectFault(tx, hooks.fault, kept);
        problems.push(
          ...describeCounts(
            new Map(kept.map((table) => [table, counted.get(table) ?? 0])),
            await rowCounts(tx, kept),
          ),
        );
        const { differences, missingTables } = await schemaDifferences(
          tx,
          await target,
        );
        problems.push(
          ...differences,
          ...missingTables.map((name) => `the update leaves no ${name} table`),
        );
        const brokenAfter = await brokenReferences(tx);
        if (brokenAfter > brokenBefore) {
          problems.push(
            `${String(brokenAfter - brokenBefore)} more rows would refer to rows that are not there`,
          );
        }
      }
      if (problems.length === 0) {
        await tx.execute(`PRAGMA user_version = ${String(to)}`);
        await tx.commit();
      } else {
        await tx.rollback();
      }
    } catch (error) {
      await tx?.rollback().catch(() => undefined);
      const opening = `The database in ${path} is at schema version ${String(from)} and this build updates it to ${String(to)}`;
      throw new RefusedDatabaseError(
        backupPath === undefined
          ? `${opening}, but the copy taken before an update could not be made: ${errorMessage(error)}. ` +
              `Nothing was changed. The build that wrote the file still reads it.`
          : `Updating the database in ${path} ${steps} failed: ${errorMessage(error)}. ` +
              `Nothing was changed: the update was rolled back, so the file is as it was found. ` +
              `The copy taken before it is at ${backupPath}. The build that wrote the file still reads it.`,
        { cause: error },
      );
    } finally {
      tx?.close();
    }
    if (problems.length > 0) {
      throw new RefusedDatabaseError(
        `Updating the database in ${path} ${steps} did not give this build's database: ${problems.join("; ")}. ` +
          `Nothing was changed: the update was rolled back, so the file is as it was found. ` +
          `The copy taken before it is at ${backupPath}. The build that wrote the file still reads it.`,
      );
    }
    log(
      "info",
      `Updated the database in ${path} ${steps}. The copy taken before the update is at ${backupPath}, and stays until you remove it.`,
      { schema_from: from, schema_to: to, backup_path: backupPath },
    );
    return { from, to, backupPath };
  } finally {
    client.close();
  }
}
