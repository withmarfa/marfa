/**
 * Where an archive export keeps what it has read until the tar can be
 * written.
 *
 * A tar header carries each entry's size, so the archive's text members and
 * its manifest have to be complete before their first byte is sent. They are
 * kept on the disk store's own filesystem, in the spool an upload lands in,
 * so what the export holds in memory is a page of rows and not the
 * instance. Two kinds of thing are kept:
 *
 * - text, appended a page at a time, hashed as it is appended, and read
 *   back as a stream; and
 * - what the export has to ask questions of while it reads or checks the
 *   selection: whether an edge's endpoints were both exported, which blob
 *   digests the exported rows name, and the rows the check of the selection
 *   has judged (`archive-validation.ts`). They live in one scratch SQLite
 *   file, where a lookup is an index probe and a walk is a keyset page.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { type Client } from "@libsql/client";
import { ScratchDatabase } from "../storage/sqlite/scratch-database.js";
import { DiskReserve, type Admission } from "../storage/disk-space.js";

/** Text appended to a file in the spool, whose length is known as it grows. */
export class TextSpool {
  /** Characters-to-bytes is not one-to-one, so the count is in bytes. */
  bytes = 0;
  private sealed = false;
  private readonly hashing = createHash("sha256");

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly admission?: Admission,
  ) {}

  static async create(path: string, reserve?: DiskReserve): Promise<TextSpool> {
    const admission = await reserve?.admit();
    try {
      return new TextSpool(path, await open(path, "wx"), admission);
    } catch (error) {
      admission?.close();
      throw error;
    }
  }

  async append(text: string): Promise<void> {
    if (text.length === 0) return;
    const bytes = Buffer.from(text);
    const write = () => this.handle.writeFile(bytes);
    if (this.admission) await this.admission.write(bytes.length, write);
    else await write();
    this.bytes += bytes.length;
    this.hashing.update(bytes);
  }

  /** The SHA-256 of everything appended, once sealed. */
  digest(): string {
    if (!this.sealed) throw new Error("The spool is still being written");
    return this.hashing.copy().digest("hex");
  }

  /** Stop writing. Reading the file back needs this first. */
  async seal(): Promise<void> {
    if (this.sealed) return;
    this.sealed = true;
    try {
      await this.handle.close();
    } finally {
      this.admission?.close();
    }
  }

  read(): Readable {
    return createReadStream(this.path);
  }
}

/** The strings one scratch table holds. */
export class KeySet {
  constructor(
    private readonly client: Client,
    private readonly table: "item_ids" | "blob_hashes",
  ) {}

  async add(members: Iterable<string>): Promise<void> {
    const batch = [...members];
    for (let at = 0; at < batch.length; at += PARAMETERS_PER_STATEMENT) {
      const slice = batch.slice(at, at + PARAMETERS_PER_STATEMENT);
      await this.client.execute({
        sql: `INSERT OR IGNORE INTO ${this.table} (key) VALUES ${slice
          .map(() => "(?)")
          .join(",")}`,
        args: slice,
      });
    }
  }

  /** Which of `members` the set holds. */
  async held(members: Iterable<string>): Promise<Set<string>> {
    const batch = [...new Set(members)];
    const found = new Set<string>();
    for (let at = 0; at < batch.length; at += PARAMETERS_PER_STATEMENT) {
      const slice = batch.slice(at, at + PARAMETERS_PER_STATEMENT);
      const { rows } = await this.client.execute({
        sql: `SELECT key FROM ${this.table} WHERE key IN (${slice
          .map(() => "?")
          .join(",")})`,
        args: slice,
      });
      for (const row of rows) found.add(row.key as string);
    }
    return found;
  }
}

/** Well under SQLite's limit on bound parameters in one statement. */
const PARAMETERS_PER_STATEMENT = 500;

/**
 * Everything one export keeps in the spool, and the one way to remove it.
 * `dispose` is safe to call more than once and on every outcome.
 */
export class ExportSpool {
  private readonly files: string[] = [];
  private readonly open: TextSpool[] = [];
  private scratch: Client | undefined;
  private scratchPath: string | undefined;
  private disposed = false;

  constructor(
    private readonly newPath: () => string,
    private readonly reserve?: DiskReserve,
  ) {}

  async text(): Promise<TextSpool> {
    const path = this.newPath();
    this.files.push(path);
    const spool = await TextSpool.create(path, this.reserve);
    this.open.push(spool);
    return spool;
  }

  /** The scratch SQLite file, created on first use. */
  async database(): Promise<Client> {
    if (!this.scratch) {
      const path = this.newPath();
      this.files.push(path);
      this.scratchPath = path;
      const client = new ScratchDatabase(path, () =>
        (this.reserve ?? new DiskReserve(path, 0)).scratch(),
      ).client(pathToFileURL(path).href);
      this.scratch = client;
      await client.batch(
        ["item_ids", "blob_hashes"].map(
          (table) =>
            `CREATE TABLE ${table} (key TEXT PRIMARY KEY) WITHOUT ROWID`,
        ),
        "write",
      );
    }
    return this.scratch;
  }

  /** The sets, in the scratch database. */
  async sets(): Promise<{ itemIds: KeySet; blobHashes: KeySet }> {
    const database = await this.database();
    return {
      itemIds: new KeySet(database, "item_ids"),
      blobHashes: new KeySet(database, "blob_hashes"),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.scratch?.close();
    await Promise.allSettled(this.open.map((spool) => spool.seal()));
    await Promise.all(
      this.files.flatMap((path) => [
        rm(path, { force: true }),
        ...(path === this.scratchPath
          ? ["-journal", "-wal", "-shm"].map((suffix) =>
              rm(path + suffix, { force: true }),
            )
          : []),
      ]),
    );
  }
}
