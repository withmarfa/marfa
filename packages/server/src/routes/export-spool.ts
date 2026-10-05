/**
 * Where an archive export keeps what it has read until the tar can be
 * written.
 *
 * A tar header carries each entry's size, so the archive's text members and
 * its manifest have to be complete before their first byte is sent. They are
 * kept on the disk store's own filesystem, in the spool an upload lands in,
 * so what the export holds in memory is one page of rows and not the
 * instance. Two kinds of thing are kept:
 *
 * - text, appended a page at a time and read back as a stream; and
 * - sets of strings, which the export has to ask questions of while it is still
 *   reading: whether an edge's endpoints were both exported, and which blob
 *   digests the exported rows name. They live in a scratch SQLite file whose
 *   members are sorted, so a lookup is an index probe and a walk is a keyset
 *   page.
 */

import { createReadStream } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";

/** Text appended to a file in the spool, whose length is known as it grows. */
export class TextSpool {
  /** Characters-to-bytes is not one-to-one, so the count is in bytes. */
  bytes = 0;
  private sealed = false;

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  static async create(path: string): Promise<TextSpool> {
    return new TextSpool(path, await open(path, "wx"));
  }

  async append(text: string): Promise<void> {
    if (text.length === 0) return;
    const bytes = Buffer.from(text);
    await this.handle.writeFile(bytes);
    this.bytes += bytes.length;
  }

  /** Stop writing. Reading the file back needs this first. */
  async seal(): Promise<void> {
    if (this.sealed) return;
    this.sealed = true;
    await this.handle.close();
  }

  read(): Readable {
    return createReadStream(this.path);
  }
}

/** The strings one scratch table holds, in order. */
export class KeySet {
  constructor(
    private readonly client: Client,
    private readonly table: "item_ids" | "blob_hashes" | "listed_blobs",
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

  /** Up to `limit` members after `after`, in order. */
  async page(after: string | undefined, limit: number): Promise<string[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT key FROM ${this.table} WHERE key > ? ORDER BY key LIMIT ?`,
      args: [after ?? "", limit],
    });
    return rows.map((row) => row.key as string);
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

  constructor(private readonly newPath: () => string) {}

  async text(): Promise<TextSpool> {
    const path = this.newPath();
    this.files.push(path);
    const spool = await TextSpool.create(path);
    this.open.push(spool);
    return spool;
  }

  /** The two sets, in a scratch SQLite file created on first use. */
  async sets(): Promise<{
    itemIds: KeySet;
    blobHashes: KeySet;
    listedBlobs: KeySet;
  }> {
    if (!this.scratch) {
      const path = this.newPath();
      this.files.push(path);
      this.scratchPath = path;
      // No journal and no sync: the file is scratch that nothing reads after
      // this export, so a crash costs nothing the boot sweep does not clear,
      // and no sidecar file is left beside it.
      const client = createClient({ url: pathToFileURL(path).href });
      this.scratch = client;
      await client.execute("PRAGMA journal_mode = OFF");
      await client.execute("PRAGMA synchronous = OFF");
      await client.execute(
        "CREATE TABLE item_ids (key TEXT PRIMARY KEY) WITHOUT ROWID",
      );
      for (const table of ["blob_hashes", "listed_blobs"]) {
        await client.execute(
          `CREATE TABLE ${table} (key TEXT PRIMARY KEY) WITHOUT ROWID`,
        );
      }
    }
    return {
      itemIds: new KeySet(this.scratch, "item_ids"),
      blobHashes: new KeySet(this.scratch, "blob_hashes"),
      listedBlobs: new KeySet(this.scratch, "listed_blobs"),
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
