/**
 * What the server keeps on disk and in memory: its SQLite files and their
 * tables, its resting memory, and the size of the program a deployment
 * carries.
 */
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Context } from "./context.js";
import { scalar, type Recorder } from "./figures.js";
import { sleep } from "./http.js";
import { readProcesses } from "./processes.js";

const run = promisify(execFile);
const MB = 1_048_576;

/** The first 100 bytes of a file, or null when it has fewer. */
function header(file: string): Buffer | null {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(100);
    return readSync(fd, buffer, 0, 100, 0) === 100 ? buffer : null;
  } finally {
    closeSync(fd);
  }
}

/** Every SQLite database directly in the state directory, by its header. */
function databases(state: string): string[] {
  return readdirSync(state)
    .map((name) => join(state, name))
    .filter((file) => {
      if (!lstatSync(file).isFile()) return false;
      return (
        header(file)?.subarray(0, 16).toString("latin1") ===
        "SQLite format 3\u0000"
      );
    });
}

const sizeOf = (file: string) => (existsSync(file) ? statSync(file).size : 0);

async function sqlite(db: string, sql: string): Promise<unknown[]> {
  const { stdout } = await run("sqlite3", ["-readonly", "-json", db, sql], {
    maxBuffer: 64 * MB,
  });
  return stdout.trim() === "" ? [] : (JSON.parse(stdout) as unknown[]);
}

/**
 * Tables, their rows and their bytes, read from a copy made with SQLite's
 * backup, which takes a consistent snapshot of a database in use.
 */
async function describe(db: string): Promise<Record<string, unknown>> {
  const bytes = header(db) as Buffer;
  const pageSize = bytes.readUInt16BE(16);
  const summary: Record<string, unknown> = {
    page_size: pageSize === 1 ? 65_536 : pageSize,
    journal: bytes[18] === 2 ? "wal" : "rollback",
    pages: bytes.readUInt32BE(28),
    freelist_pages: bytes.readUInt32BE(36),
  };
  const scratch = mkdtempSync(join(tmpdir(), "slice-bench-"));
  try {
    const copy = join(scratch, "copy.db");
    await run("sqlite3", ["-readonly", db, `.backup '${copy}'`]);
    const tables = (await sqlite(
      copy,
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )) as { name: string; sql: string | null }[];
    const used = new Map<string, number>();
    try {
      for (const row of (await sqlite(
        copy,
        "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name",
      )) as { name: string; bytes: number }[]) {
        used.set(row.name, row.bytes);
      }
    } catch {
      summary.bytes_note =
        "this sqlite3 has no dbstat table, so bytes per table are missing";
    }
    const rows: { name: string; rows: number | null; bytes: number | null }[] =
      [];
    for (const table of tables) {
      let count: number | null = null;
      try {
        const answer = (await sqlite(
          copy,
          `SELECT COUNT(*) AS n FROM "${table.name.replaceAll('"', '""')}"`,
        )) as { n: number }[];
        count = answer[0]?.n ?? null;
      } catch {
        count = null;
      }
      rows.push({
        name: table.name,
        rows: count,
        bytes: used.get(table.name) ?? null,
      });
    }
    // An index's bytes are kept apart from its table's.
    const indexBytes = [...used.entries()]
      .filter(([name]) => !tables.some((table) => table.name === name))
      .reduce((sum, [, size]) => sum + size, 0);
    summary.tables = rows;
    summary.index_bytes = used.size > 0 ? indexBytes : null;
  } catch (error) {
    summary.error = `the sqlite3 command line could not read it: ${String(error).slice(0, 300)}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return summary;
}

/** The database's size on disk, and its tables, under the name `when`. */
export async function databaseSize(ctx: Context, when: string): Promise<void> {
  const files = databases(ctx.state);
  if (files.length === 0) {
    ctx.record.note(`no SQLite file was found in ${ctx.state}`);
    return;
  }
  let main = 0;
  let wal = 0;
  for (const db of files) {
    main += sizeOf(db);
    wal += sizeOf(`${db}-wal`) + sizeOf(`${db}-shm`);
  }
  const items = ctx.ids.length + ctx.singleIds.length;
  const names = files
    .map((file) => file.slice(ctx.state.length + 1))
    .join(", ");
  ctx.record.add(
    scalar(
      {
        name: `db_main_${when}_mb`,
        label: `Database file, ${when.replaceAll("_", " ")}`,
        unit: "MB",
        note: names,
      },
      main / MB,
    ),
  );
  ctx.record.add(
    scalar(
      {
        name: `db_wal_${when}_mb`,
        label: `Write-ahead log and shared memory, ${when.replaceAll("_", " ")}`,
        unit: "MB",
      },
      wal / MB,
    ),
  );
  ctx.record.add(
    scalar(
      {
        name: `db_bytes_per_item_${when}`,
        label: `Database bytes per item, ${when.replaceAll("_", " ")}`,
        unit: "bytes",
        note: `all files over ${items} items`,
      },
      items === 0 ? 0 : (main + wal) / items,
    ),
  );
  const described: Record<string, unknown> = {};
  for (const db of files)
    described[db.slice(ctx.state.length + 1)] = await describe(db);
  ctx.record.run.storage[when] = described;
  ctx.record.save();
}

/** Memory once the server has been left alone, the median of five readings. */
export async function restingMemory(
  ctx: Context,
  name: string,
  label: string,
  waitMs: number,
): Promise<void> {
  await sleep(waitMs);
  const server: number[] = [];
  const tree: number[] = [];
  for (let i = 0; i < 5; i++) {
    const reading = await readProcesses(ctx.state);
    server.push(reading.serverMb);
    tree.push(reading.treeMb);
    if (i < 4) await sleep(1_000);
  }
  const median = (list: number[]) =>
    [...list].sort((a, b) => a - b)[2] as number;
  ctx.record.add(
    scalar(
      {
        name,
        label,
        unit: "MB",
        note: `resident memory of the server processes, median of 5 readings after ${Math.round(waitMs / 1000)} s alone; with the adapter's supervisor, ${median(tree).toFixed(1)} MB`,
      },
      median(server),
    ),
  );
}

/** Bytes of a file, or of every regular file under a folder, each inode once. */
function bytesUnder(path: string, seen = new Set<string>()): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isDirectory()) {
    return readdirSync(path).reduce(
      (sum, name) => sum + bytesUnder(join(path, name), seen),
      0,
    );
  }
  const inode = `${stat.dev}:${stat.ino}`;
  if (!stat.isFile() || seen.has(inode)) return 0;
  seen.add(inode);
  return stat.size;
}

/** `--program <label>=<path>`: what a deployment of the server carries. */
export function programSizes(record: Recorder, programs: string[]): void {
  if (programs.length === 0) return;
  let total = 0;
  const parts: string[] = [];
  for (const entry of programs) {
    const eq = entry.indexOf("=");
    if (eq <= 0)
      throw new Error(`--program needs <label>=<path>, not ${entry}`);
    const label = entry.slice(0, eq);
    const path = resolve(entry.slice(eq + 1));
    const bytes = bytesUnder(path);
    total += bytes;
    parts.push(`${label} ${(bytes / MB).toFixed(1)} MB`);
    record.add(
      scalar(
        {
          name: `program_${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}_mb`,
          label: `Program: ${label}`,
          unit: "MB",
          note: "apparent size of its regular files, symbolic links not followed",
        },
        bytes / MB,
      ),
    );
  }
  record.add(
    scalar(
      {
        name: "program_total_mb",
        label: "Program size, everything a deployment runs",
        unit: "MB",
        note: parts.join("; "),
      },
      total / MB,
    ),
  );
}
