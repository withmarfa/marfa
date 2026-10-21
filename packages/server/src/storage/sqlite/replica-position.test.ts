import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkReplica,
  localLtxDir,
  lz4Decompress,
  refusalMessage,
  replicaTxid,
} from "./replica-position.js";

/**
 * The decision Litestream's own record and the database's log feed. The
 * end-to-end cases, with the real Litestream and a bucket, are the backup
 * fixtures in `conformance/src/suites/backup/`; these reach the paths a
 * real run reaches only by chance, such as a log that a stop truncated.
 *
 * Every log here is one SQLite wrote. The LTX files are written by the test
 * in Litestream 0.5's layout, with each page an LZ4 block of literals.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), "replica-position-"));
  roots.push(root);
  return root;
}

/** A database whose log holds every write, as a running instance leaves it. */
interface Volume {
  sqlitePath: string;
  walPath: string;
  pageSize: number;
}

/**
 * Writes `rows` rows on a database in WAL mode and copies the database and
 * its log while the connection is still open, so the copy's log holds the
 * writes as an instance's does between checkpoints.
 */
async function volumeWith(rows: number): Promise<Volume> {
  const source = freshDir();
  const path = join(source, "marfa.db");
  const client = createClient({ url: `file:${path}` });
  try {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA wal_autocheckpoint = 0");
    await client.execute("CREATE TABLE t (n INTEGER, pad TEXT)");
    for (let n = 1; n <= rows; n++) {
      await client.execute({
        sql: "INSERT INTO t VALUES (?, ?)",
        args: [n, "x".repeat(500)],
      });
    }
    const volume = freshDir();
    const sqlitePath = join(volume, "marfa.db");
    copyFileSync(path, sqlitePath);
    copyFileSync(`${path}-wal`, `${sqlitePath}-wal`);
    const wal = readFileSync(`${sqlitePath}-wal`);
    return {
      sqlitePath,
      walPath: `${sqlitePath}-wal`,
      pageSize: wal.readUInt32BE(8),
    };
  } finally {
    client.close();
  }
}

/** The database's pages as SQLite reads them, from a checkpointed copy. */
async function pagesOf(volume: Volume): Promise<Buffer[]> {
  const dir = freshDir();
  const copy = join(dir, "copy.db");
  copyFileSync(volume.sqlitePath, copy);
  if (existsSync(volume.walPath)) copyFileSync(volume.walPath, `${copy}-wal`);
  const client = createClient({ url: `file:${copy}` });
  await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  client.close();
  const bytes = readFileSync(copy);
  const pages: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += volume.pageSize) {
    pages.push(bytes.subarray(at, at + volume.pageSize));
  }
  return pages;
}

/** An LZ4 block of `data` as literals alone, which every decoder reads. */
function lz4Literals(data: Buffer): Buffer {
  const extra: number[] = [];
  if (data.length >= 15) {
    let rest = data.length - 15;
    while (rest >= 255) {
      extra.push(255);
      rest -= 255;
    }
    extra.push(rest);
  }
  return Buffer.concat([
    Buffer.from([Math.min(data.length, 15) << 4, ...extra]),
    data,
  ]);
}

interface Ltx {
  maxTxid: bigint;
  commit: number;
  pageSize: number;
  walOffset: number;
  walSize: number;
  salt1: number;
  salt2: number;
  pages: [number, Buffer][];
}

/** Writes an LTX file into the volume's Litestream record. */
function writeLtx(sqlitePath: string, ltx: Ltx): void {
  const header = Buffer.alloc(100);
  header.write("LTX1", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ltx.pageSize, 8);
  header.writeUInt32BE(ltx.commit, 12);
  header.writeBigUInt64BE(ltx.maxTxid, 16);
  header.writeBigUInt64BE(ltx.maxTxid, 24);
  header.writeBigInt64BE(BigInt(ltx.walOffset), 48);
  header.writeBigInt64BE(BigInt(ltx.walSize), 56);
  header.writeUInt32BE(ltx.salt1, 64);
  header.writeUInt32BE(ltx.salt2, 68);
  const parts: Buffer[] = [header];
  for (const [pgno, data] of ltx.pages) {
    const pageHeader = Buffer.alloc(10);
    const block = lz4Literals(data);
    pageHeader.writeUInt32BE(pgno, 0);
    pageHeader.writeUInt16BE(1, 4);
    pageHeader.writeUInt32BE(block.length, 6);
    parts.push(pageHeader, block);
  }
  parts.push(Buffer.alloc(6), Buffer.alloc(16));
  const dir = localLtxDir(sqlitePath);
  mkdirSync(dir, { recursive: true });
  const hex = ltx.maxTxid.toString(16).padStart(16, "0");
  writeFileSync(join(dir, `${hex}-${hex}.ltx`), Buffer.concat(parts));
}

/** An LTX header naming the volume's log as it stands, as Litestream writes one after its last sync. */
async function ltxAtLogEnd(
  volume: Volume,
  maxTxid: bigint,
  pages: number[] = [],
): Promise<Ltx> {
  const wal = readFileSync(volume.walPath);
  const frameSize = volume.pageSize + 24;
  expect((wal.length - 32) % frameSize).toBe(0);
  const state = await pagesOf(volume);
  return {
    maxTxid,
    commit: state.length,
    pageSize: volume.pageSize,
    walOffset: wal.length - frameSize,
    walSize: frameSize,
    salt1: wal.readUInt32BE(16),
    salt2: wal.readUInt32BE(20),
    pages: pages.map((pgno) => [pgno, state[pgno - 1] ?? Buffer.alloc(0)]),
  };
}

describe("replicaTxid", () => {
  it("answers the newest transaction any listed file reaches, and 0 for an empty replica", () => {
    expect(replicaTxid("[]")).toBe(0n);
    expect(
      replicaTxid(
        JSON.stringify([
          {
            level: 0,
            min_txid: "0000000000000009",
            max_txid: "0000000000000009",
          },
          {
            level: 1,
            min_txid: "0000000000000001",
            max_txid: "000000000000000c",
          },
          {
            level: 9,
            min_txid: "0000000000000001",
            max_txid: "0000000000000008",
          },
        ]),
      ),
    ).toBe(12n);
  });

  it("refuses a listing it cannot read rather than answering an empty replica", () => {
    for (const listing of [
      "",
      "{}",
      "null",
      '[{"level":0}]',
      '[{"max_txid":"12"}]',
    ]) {
      expect(() => replicaTxid(listing), listing).toThrow();
    }
  });
});

describe("lz4Decompress", () => {
  it("reads literals, matches and overlapping matches", () => {
    const out = Buffer.alloc(13);
    lz4Decompress(
      Buffer.from([0x44, ...Buffer.from("abcd"), 4, 0, 0x10, 0x78]),
      out,
    );
    expect(out.toString("latin1")).toBe("abcdabcdabcdx");

    const run = Buffer.alloc(9);
    lz4Decompress(Buffer.from([0x13, 0x61, 1, 0, 0x10, 0x62]), run);
    expect(run.toString("latin1")).toBe("aaaaaaaab");
  });

  it("refuses a block that does not fill the page or reaches outside it", () => {
    expect(() => {
      lz4Decompress(Buffer.from([0x30, 1, 2, 3]), Buffer.alloc(4));
    }).toThrow();
    expect(() => {
      lz4Decompress(
        Buffer.from([0x14, 0x61, 9, 0, 0x10, 0x62]),
        Buffer.alloc(10),
      );
    }).toThrow();
  });
});

describe("checkReplica", () => {
  it("starts on any database when the replica is empty, whatever the volume records", async () => {
    const volume = await volumeWith(3);
    expect(checkReplica(volume.sqlitePath, 0n)).toEqual({ start: true });
  });

  it("refuses a database with no record of replicating when the replica holds transactions", async () => {
    const volume = await volumeWith(3);
    expect(checkReplica(volume.sqlitePath, 4n)).toEqual({
      start: false,
      reason: "unrecorded",
      replica: 4n,
    });
  });

  it("starts when the record reaches the replica's newest transaction and the log continues from it", async () => {
    const volume = await volumeWith(3);
    writeLtx(volume.sqlitePath, await ltxAtLogEnd(volume, 5n));
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });
    // A record ahead of the replica is a sync the bucket has not yet had.
    expect(checkReplica(volume.sqlitePath, 4n)).toEqual({ start: true });
  });

  it("refuses when the record ends before the replica's newest transaction", async () => {
    const volume = await volumeWith(3);
    writeLtx(volume.sqlitePath, await ltxAtLogEnd(volume, 5n));
    // The witness: the same volume against a replica it reaches.
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });
    expect(checkReplica(volume.sqlitePath, 6n)).toEqual({
      start: false,
      reason: "behind",
      local: 5n,
      replica: 6n,
    });
  });

  it("starts when the log has moved on to its next generation since the record", async () => {
    const volume = await volumeWith(3);
    const ltx = await ltxAtLogEnd(volume, 5n);
    writeLtx(volume.sqlitePath, {
      ...ltx,
      salt1: (ltx.salt1 - 1) >>> 0,
      salt2: 7,
    });
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });
  });

  it("refuses when the log of the recorded generation no longer reaches the recorded position", async () => {
    const volume = await volumeWith(6);
    writeLtx(volume.sqlitePath, await ltxAtLogEnd(volume, 5n));
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });

    // A copy of this volume taken before its last write: the same log, shorter.
    truncateSync(
      volume.walPath,
      statSync(volume.walPath).size - (volume.pageSize + 24),
    );
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({
      start: false,
      reason: "replaced",
      local: 5n,
      replica: 5n,
    });
  });

  it("refuses when a frame of the recorded log was overwritten", async () => {
    const volume = await volumeWith(3);
    writeLtx(volume.sqlitePath, await ltxAtLogEnd(volume, 5n));
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });

    const wal = readFileSync(volume.walPath);
    wal[32 + 24 + 100] = (wal[32 + 24 + 100] ?? 0) ^ 0xff;
    writeFileSync(volume.walPath, wal);
    expect(checkReplica(volume.sqlitePath, 5n)).toMatchObject({
      start: false,
      reason: "replaced",
    });
  });

  it("starts without a log when the database holds the recorded transaction's pages, as after a stop that truncated it", async () => {
    const volume = await volumeWith(3);
    const ltx = await ltxAtLogEnd(volume, 5n, [1, 2]);
    writeLtx(volume.sqlitePath, ltx);
    const state = await pagesOf(volume);
    writeFileSync(volume.sqlitePath, Buffer.concat(state));
    rmSync(volume.walPath);
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });

    writeFileSync(volume.walPath, "");
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });
  });

  it("refuses without a log when the database is an older state put in its place", async () => {
    const older = await volumeWith(2);
    const newer = await volumeWith(6);
    const ltx = await ltxAtLogEnd(newer, 5n, [1, 2]);
    writeLtx(older.sqlitePath, ltx);
    writeLtx(newer.sqlitePath, ltx);
    for (const volume of [older, newer]) {
      writeFileSync(volume.sqlitePath, Buffer.concat(await pagesOf(volume)));
      rmSync(volume.walPath);
    }
    // The witness: the record's own database passes.
    expect(checkReplica(newer.sqlitePath, 5n)).toEqual({ start: true });
    expect(checkReplica(older.sqlitePath, 5n)).toEqual({
      start: false,
      reason: "replaced",
      local: 5n,
      replica: 5n,
    });
  });

  it("refuses without a log when the database is not the size the recorded transaction left", async () => {
    const volume = await volumeWith(3);
    const ltx = await ltxAtLogEnd(volume, 5n, [1]);
    writeLtx(volume.sqlitePath, { ...ltx, commit: ltx.commit + 1 });
    writeFileSync(volume.sqlitePath, Buffer.concat(await pagesOf(volume)));
    rmSync(volume.walPath);
    expect(checkReplica(volume.sqlitePath, 5n)).toMatchObject({
      start: false,
      reason: "replaced",
    });
  });

  it("reads a log of another generation over the database before comparing pages", async () => {
    const volume = await volumeWith(3);
    const ltx = await ltxAtLogEnd(volume, 5n, [1, 2]);
    // A record naming no log position: the comparison is by pages, which the
    // log holds and the database file does not yet.
    writeLtx(volume.sqlitePath, {
      ...ltx,
      walOffset: 0,
      walSize: 0,
      salt1: 0,
      salt2: 0,
    });
    expect(checkReplica(volume.sqlitePath, 5n)).toEqual({ start: true });

    truncateSync(volume.walPath, 0);
    expect(checkReplica(volume.sqlitePath, 5n)).toMatchObject({
      start: false,
      reason: "replaced",
    });
  });
});

describe("refusalMessage", () => {
  it("names the new-prefix procedure, the restore and the override, and says the bucket is unchanged", () => {
    const message = refusalMessage(
      { start: false, reason: "behind", local: 5n, replica: 9n },
      { sqlitePath: "/data/marfa.db", bucket: "a-bucket", prefix: "blobs" },
    );
    expect(message).toContain("blobs/db in the bucket a-bucket");
    expect(message).toContain("transaction 5");
    expect(message).toContain("up to 9");
    expect(message).toContain("the bucket is unchanged");
    expect(message).toContain('"Start a backup under a new prefix"');
    expect(message).toContain("#start-a-backup-under-a-new-prefix");
    expect(message).toContain("MARFA_REPLACE_NEWER_REPLICA=true");
  });
});
