/**
 * Whether the database on a volume may be replicated to its bucket without
 * overwriting newer writes there.
 *
 * Litestream 0.5 (pinned in `deploy/Dockerfile`) replicates whatever
 * database it finds. When the database is older than the replica, it logs
 * `detected database behind replica` and uploads the database's next
 * transactions on top, and when the database was replaced on a volume that
 * keeps Litestream's own record it says nothing at all. Either way the older
 * state becomes the replica's newest, and the writes after it survive only
 * in the replica's history, which expires.
 *
 * The record Litestream keeps beside the database, `.<name>-litestream/`,
 * holds the transactions this volume replicated as LTX files. The newest
 * names the last transaction and the log position it was read from: the
 * write-ahead log's salts, which SQLite draws anew for each generation of
 * the log, and the offset after its last frame. A database that is still
 * the one that record describes, and whose last transaction is not older
 * than the replica's, is safe to replicate. Litestream writes LTX files
 * without checksums, so the comparison is by position and, where the log no
 * longer holds the position, by page content.
 *
 * Transaction IDs count within one replica's history only, so the record is
 * compared with a replica only when it was made replicating to that replica.
 * The entrypoint names the replica it starts replicating to in a file beside
 * the database, `<name>-replica`, and a record whose file names another
 * replica is no record of this one.
 *
 * Nothing here writes: the volume and the bucket are left as they were.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const LTX_HEADER_SIZE = 100;
const LTX_PAGE_HEADER_SIZE = 6;
/** Set on every page Litestream 0.5 writes: a 4-byte size and an LZ4 block follow. */
const LTX_PAGE_FLAG_SIZE = 1;
const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;
const LTX_FILE_NAME = /^([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/;
const TXID = /^[0-9a-f]{16}$/;

/** The fields of an LTX header this check reads. */
export interface LtxHeader {
  pageSize: number;
  /** The database's size in pages after the file's last transaction. */
  commit: number;
  maxTxid: bigint;
  /** The log offset the file's frames start at, or 0 when it names none. */
  walOffset: number;
  walSize: number;
  walSalt1: number;
  walSalt2: number;
}

/** A replica as Litestream reaches it: `<prefix>/db` in `bucket` at `endpoint`. */
export interface ReplicaName {
  /** `S3_ENDPOINT` as the entrypoint hands it to Litestream, empty for AWS. */
  endpoint: string;
  bucket: string;
  prefix: string;
}

export type ReplicaVerdict =
  | { start: true }
  | {
      start: false;
      /**
       * `behind`: the volume's record ends before the replica does.
       * `unrecorded`: the volume holds no record of replicating.
       * `elsewhere`: the volume's record is of replicating to another replica.
       * `replaced`: the database is not the one the record describes.
       */
      reason: "behind" | "unrecorded" | "elsewhere" | "replaced";
      /** The last transaction this volume replicated, when it has a record. */
      local?: bigint;
      /** For `elsewhere`, the replica the record is of, when its file is readable. */
      recordedFor?: ReplicaName;
      replica: bigint;
    };

/**
 * The replica's newest transaction, from the JSON `litestream ltx -level
 * all -json` prints: 0 when the replica holds nothing.
 */
export function replicaTxid(listing: string): bigint {
  const files: unknown = JSON.parse(listing);
  if (!Array.isArray(files)) {
    throw new Error("the replica listing is not a list of files");
  }
  let newest = 0n;
  for (const file of files as unknown[]) {
    const max =
      typeof file === "object" && file !== null && "max_txid" in file
        ? file.max_txid
        : undefined;
    if (typeof max !== "string" || !TXID.test(max)) {
      throw new Error(
        "the replica listing names a file without a transaction ID",
      );
    }
    const txid = BigInt(`0x${max}`);
    if (txid > newest) newest = txid;
  }
  return newest;
}

/** Positional reads of a file, closed by `close`. */
class FileReader {
  private readonly fd: number;
  readonly size: number;

  constructor(path: string) {
    this.fd = openSync(path, "r");
    this.size = fstatSync(this.fd).size;
  }

  /** Exactly `length` bytes at `position`, or `undefined` past the end. */
  read(position: number, length: number): Buffer | undefined {
    if (position + length > this.size) return undefined;
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buffer, done, length - done, position + done);
      if (n === 0) return undefined;
      done += n;
    }
    return buffer;
  }

  close(): void {
    closeSync(this.fd);
  }
}

function withFile<T>(path: string, use: (file: FileReader) => T): T {
  const file = new FileReader(path);
  try {
    return use(file);
  } finally {
    file.close();
  }
}

export function parseLtxHeader(buffer: Buffer): LtxHeader {
  if (
    buffer.length < LTX_HEADER_SIZE ||
    buffer.toString("latin1", 0, 4) !== "LTX1"
  ) {
    throw new Error("not an LTX file");
  }
  return {
    pageSize: buffer.readUInt32BE(8),
    commit: buffer.readUInt32BE(12),
    maxTxid: buffer.readBigUInt64BE(24),
    walOffset: Number(buffer.readBigInt64BE(48)),
    walSize: Number(buffer.readBigInt64BE(56)),
    walSalt1: buffer.readUInt32BE(64),
    walSalt2: buffer.readUInt32BE(68),
  };
}

/** The file beside `sqlitePath` that names the replica its record is of. */
export function replicaMarkerPath(sqlitePath: string): string {
  return `${sqlitePath}-replica`;
}

/**
 * The marker file's contents for `name`, byte for byte as
 * `deploy/entrypoint.sh` writes them.
 */
export function replicaMarker(name: ReplicaName): string {
  return `endpoint=${name.endpoint}\nbucket=${name.bucket}\nprefix=${name.prefix}\n`;
}

/**
 * The replica the marker beside `sqlitePath` names: `undefined` when there
 * is no marker, `unreadable` when it is not one `replicaMarker` writes.
 */
export function readReplicaMarker(
  sqlitePath: string,
): ReplicaName | "unreadable" | undefined {
  const path = replicaMarkerPath(sqlitePath);
  if (!existsSync(path)) return undefined;
  const match = /^endpoint=([^\n]*)\nbucket=([^\n]*)\nprefix=([^\n]*)\n$/.exec(
    readFileSync(path, "utf8"),
  );
  if (!match) return "unreadable";
  return {
    endpoint: match[1] ?? "",
    bucket: match[2] ?? "",
    prefix: match[3] ?? "",
  };
}

/**
 * Whether `a` and `b` name one replica. An HTTP endpoint is compared as a
 * URL, so the case of its scheme and host, a default port and a trailing
 * slash do not tell two apart.
 */
export function sameReplica(a: ReplicaName, b: ReplicaName): boolean {
  return (
    a.bucket === b.bucket &&
    a.prefix === b.prefix &&
    endpointKey(a.endpoint) === endpointKey(b.endpoint)
  );
}

function endpointKey(endpoint: string): string {
  if (URL.canParse(endpoint)) {
    const url = new URL(endpoint);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    }
  }
  return endpoint.replace(/\/+$/, "");
}

/** The directory Litestream keeps its level-0 LTX files in for `sqlitePath`. */
export function localLtxDir(sqlitePath: string): string {
  return join(
    dirname(sqlitePath),
    `.${basename(sqlitePath)}-litestream`,
    "ltx",
    "0",
  );
}

/** The newest level-0 LTX file this volume wrote, if any. */
export function newestLocalLtx(
  sqlitePath: string,
): { path: string; header: LtxHeader } | undefined {
  const dir = localLtxDir(sqlitePath);
  if (!existsSync(dir)) return undefined;
  let newest: { name: string; max: bigint } | undefined;
  for (const name of readdirSync(dir)) {
    const match = LTX_FILE_NAME.exec(name);
    if (!match?.[2]) continue;
    const max = BigInt(`0x${match[2]}`);
    if (newest === undefined || max > newest.max) newest = { name, max };
  }
  if (newest === undefined) return undefined;
  const path = join(dir, newest.name);
  const header = parseLtxHeader(
    withFile(path, (file) => file.read(0, LTX_HEADER_SIZE)) ?? Buffer.alloc(0),
  );
  return { path, header };
}

/**
 * Decompresses one LZ4 block into `out`, which it must fill exactly. LZ4's
 * block format: a token whose high nibble is a literal length and low
 * nibble a match length, each extended by bytes of 255, the literals, then
 * a two-byte little-endian offset back into the output.
 */
export function lz4Decompress(src: Buffer, out: Buffer): void {
  let s = 0;
  let d = 0;
  const fail = (): never => {
    throw new Error("an LTX page is not a valid LZ4 block");
  };
  const length = (start: number): number => {
    let n = start;
    if (start === 15) {
      let byte: number;
      do {
        byte = src[s++] ?? fail();
        n += byte;
      } while (byte === 255);
    }
    return n;
  };
  while (s < src.length) {
    const token = src[s++] ?? fail();
    const literals = length(token >> 4);
    if (s + literals > src.length || d + literals > out.length) fail();
    src.copy(out, d, s, s + literals);
    s += literals;
    d += literals;
    if (s === src.length) break;
    const low = src[s++] ?? fail();
    const high = src[s++] ?? fail();
    const offset = low | (high << 8);
    if (offset === 0 || offset > d) fail();
    const match = length(token & 15) + 4;
    if (d + match > out.length) fail();
    for (let i = 0; i < match; i++, d++) out[d] = out[d - offset] ?? 0;
  }
  if (d !== out.length) fail();
}

/** Every page an LTX file holds, in the order it holds them. */
function* ltxPages(
  path: string,
  header: LtxHeader,
): Generator<{ pgno: number; data: Buffer }> {
  const file = new FileReader(path);
  try {
    let at = LTX_HEADER_SIZE;
    for (;;) {
      const pageHeader = file.read(at, LTX_PAGE_HEADER_SIZE);
      if (pageHeader === undefined) throw new Error("an LTX file ends early");
      at += LTX_PAGE_HEADER_SIZE;
      const pgno = pageHeader.readUInt32BE(0);
      const flags = pageHeader.readUInt16BE(4);
      if (pgno === 0 && flags === 0) return;
      if (flags !== LTX_PAGE_FLAG_SIZE) {
        throw new Error("an LTX page is in a format this check does not read");
      }
      const sizeField = file.read(at, 4);
      if (sizeField === undefined) throw new Error("an LTX file ends early");
      at += 4;
      const compressed = file.read(at, sizeField.readUInt32BE(0));
      if (compressed === undefined) throw new Error("an LTX file ends early");
      at += compressed.length;
      const data = Buffer.alloc(header.pageSize);
      lz4Decompress(compressed, data);
      yield { pgno, data };
    }
  } finally {
    file.close();
  }
}

/** SQLite's cumulative log checksum over `buffer[start, end)`. */
function walChecksum(
  buffer: Buffer,
  start: number,
  end: number,
  seed: [number, number],
  bigEndian: boolean,
): [number, number] {
  let [s0, s1] = seed;
  for (let i = start; i < end; i += 8) {
    const x0 = bigEndian ? buffer.readUInt32BE(i) : buffer.readUInt32LE(i);
    const x1 = bigEndian
      ? buffer.readUInt32BE(i + 4)
      : buffer.readUInt32LE(i + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

interface WalHeader {
  pageSize: number;
  salt1: number;
  salt2: number;
  bigEndian: boolean;
  checksum: [number, number];
}

function readWalHeader(file: FileReader): WalHeader | undefined {
  const header = file.read(0, WAL_HEADER_SIZE);
  if (header === undefined) return undefined;
  const magic = header.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return undefined;
  const bigEndian = magic === 0x377f0683;
  const checksum = walChecksum(header, 0, 24, [0, 0], bigEndian);
  if (
    checksum[0] !== header.readUInt32BE(24) ||
    checksum[1] !== header.readUInt32BE(28)
  ) {
    return undefined;
  }
  return {
    pageSize: header.readUInt32BE(8),
    salt1: header.readUInt32BE(16),
    salt2: header.readUInt32BE(20),
    bigEndian,
    checksum,
  };
}

/**
 * Walks the log's valid frames from the start, calling `frame` for each,
 * until `end` or the first frame that does not belong: another generation's
 * salts, a checksum that does not chain, or the end of the file. Answers the
 * offset after the last commit frame it passed.
 */
function walkWal(
  file: FileReader,
  header: WalHeader,
  end: number,
  frame: (pgno: number, offset: number, commit: number) => void,
): number {
  const frameSize = WAL_FRAME_HEADER_SIZE + header.pageSize;
  let checksum = header.checksum;
  let committed = WAL_HEADER_SIZE;
  for (let at = WAL_HEADER_SIZE; at + frameSize <= end; at += frameSize) {
    const bytes = file.read(at, frameSize);
    if (bytes === undefined) break;
    if (
      bytes.readUInt32BE(8) !== header.salt1 ||
      bytes.readUInt32BE(12) !== header.salt2
    ) {
      break;
    }
    checksum = walChecksum(bytes, 0, 8, checksum, header.bigEndian);
    checksum = walChecksum(
      bytes,
      WAL_FRAME_HEADER_SIZE,
      frameSize,
      checksum,
      header.bigEndian,
    );
    if (
      checksum[0] !== bytes.readUInt32BE(16) ||
      checksum[1] !== bytes.readUInt32BE(20)
    ) {
      break;
    }
    const commit = bytes.readUInt32BE(4);
    frame(bytes.readUInt32BE(0), at, commit);
    if (commit !== 0) committed = at + frameSize;
  }
  return committed;
}

/**
 * Whether the log beside the database continues from the position the LTX
 * header names: `continues` when it is the same generation and every frame
 * up to the position is intact and ends on a commit, `later` when it is the
 * generation after, `broken` when it is the same generation but does not
 * reach the position intact, and `unknown` when there is no log, the header
 * names no position, or the log is of another generation.
 */
function walFromPosition(
  walPath: string,
  ltx: LtxHeader,
): "continues" | "later" | "broken" | "unknown" {
  if (!existsSync(walPath) || ltx.walOffset === 0) return "unknown";
  return withFile(walPath, (file) => {
    const header = readWalHeader(file);
    if (header?.pageSize !== ltx.pageSize) return "unknown";
    if (header.salt1 === ltx.walSalt1 && header.salt2 === ltx.walSalt2) {
      const end = ltx.walOffset + ltx.walSize;
      return walkWal(file, header, end, () => undefined) === end
        ? "continues"
        : "broken";
    }
    // A restart of the log adds one to the first salt and draws the second.
    return header.salt1 === (ltx.walSalt1 + 1) >>> 0 ? "later" : "unknown";
  });
}

/**
 * Whether the database as SQLite would read it now, the file with the
 * log's committed frames over it, holds every page of the LTX file as the
 * file holds it, and is the size the file's last transaction left it.
 */
function holdsLtxPages(
  sqlitePath: string,
  ltxPath: string,
  ltx: LtxHeader,
): boolean {
  const walPath = `${sqlitePath}-wal`;
  const overlay = new Map<number, number>();
  let walPages: number | undefined;
  const wal = existsSync(walPath) ? new FileReader(walPath) : undefined;
  try {
    const header = wal ? readWalHeader(wal) : undefined;
    if (wal && header?.pageSize === ltx.pageSize) {
      const pending = new Map<number, number>();
      walkWal(wal, header, wal.size, (pgno, offset, commit) => {
        pending.set(pgno, offset);
        if (commit !== 0) {
          for (const [page, at] of pending) overlay.set(page, at);
          pending.clear();
          walPages = commit;
        }
      });
    }
    return withFile(sqlitePath, (db) => {
      const pages = walPages ?? db.size / ltx.pageSize;
      if (pages !== ltx.commit) return false;
      for (const { pgno, data } of ltxPages(ltxPath, ltx)) {
        const at = overlay.get(pgno);
        const current =
          at !== undefined && wal
            ? wal.read(at + WAL_FRAME_HEADER_SIZE, ltx.pageSize)
            : db.read((pgno - 1) * ltx.pageSize, ltx.pageSize);
        if (!current?.equals(data)) return false;
      }
      return true;
    });
  } finally {
    wal?.close();
  }
}

/**
 * Whether the database at `sqlitePath` may be replicated to the replica
 * `target`, whose newest transaction is `replica`.
 *
 * A record with no marker beside it is taken to be of `target`, so that a
 * volume replicated before the entrypoint wrote markers still starts; the
 * entrypoint then writes the marker.
 *
 * A log that continues from the recorded position answers before the
 * database file is read, so an older database file put in place beside the
 * volume's own log passes. Nothing on the volume can tell it apart: the
 * record holds only the pages of recent transactions, without checksums,
 * and SQLite in WAL mode does not count commits in the database header.
 */
export function checkReplica(
  sqlitePath: string,
  replica: bigint,
  target: ReplicaName,
): ReplicaVerdict {
  if (replica === 0n) return { start: true };
  const marker = readReplicaMarker(sqlitePath);
  if (marker === "unreadable") {
    return { start: false, reason: "elsewhere", replica };
  }
  if (marker !== undefined && !sameReplica(marker, target)) {
    return { start: false, reason: "elsewhere", recordedFor: marker, replica };
  }
  const newest = newestLocalLtx(sqlitePath);
  if (newest === undefined)
    return { start: false, reason: "unrecorded", replica };
  const local = newest.header.maxTxid;
  if (local < replica)
    return { start: false, reason: "behind", local, replica };
  const wal = walFromPosition(`${sqlitePath}-wal`, newest.header);
  if (wal === "continues" || wal === "later") return { start: true };
  if (
    wal === "unknown" &&
    holdsLtxPages(sqlitePath, newest.path, newest.header)
  ) {
    return { start: true };
  }
  return { start: false, reason: "replaced", local, replica };
}

const GUIDE =
  "https://github.com/withmarfa/marfa/blob/main/deploy/README.md#start-a-backup-under-a-new-prefix";

/** A replica as a message names it, with its endpoint when that is what tells two apart. */
function describeReplica(name: ReplicaName, withEndpoint: boolean): string {
  const at = `the replica at ${name.prefix}/db in the bucket ${name.bucket}`;
  if (!withEndpoint) return at;
  return name.endpoint === ""
    ? `${at} with no S3_ENDPOINT`
    : `${at} at ${name.endpoint}`;
}

/** What the entrypoint prints when it does not start replication. */
export function refusalMessage(
  verdict: Extract<ReplicaVerdict, { start: false }>,
  where: { sqlitePath: string } & ReplicaName,
): string {
  const other = verdict.recordedFor;
  const endpointDiffers =
    other !== undefined &&
    other.endpoint !== where.endpoint &&
    other.bucket === where.bucket &&
    other.prefix === where.prefix;
  const replica = describeReplica(where, endpointDiffers);
  const finding = {
    behind: `The database at ${where.sqlitePath} is older than ${replica}: this volume last replicated transaction ${String(verdict.local)}, and the replica holds transactions up to ${String(verdict.replica)}.`,
    unrecorded: `The database at ${where.sqlitePath} has no record of replicating to ${replica}, which holds transactions up to ${String(verdict.replica)}, so it may be older than the replica.`,
    elsewhere:
      other === undefined
        ? `The database at ${where.sqlitePath} has a record of replicating, but ${replicaMarkerPath(where.sqlitePath)}, which names the replica that record is of, cannot be read. So it has no record of replicating to ${replica}, which holds transactions up to ${String(verdict.replica)}, and it may be older than the replica. To check it as a volume an earlier image replicated, delete ${replicaMarkerPath(where.sqlitePath)} and start again.`
        : `The database at ${where.sqlitePath} last replicated to ${describeReplica(other, endpointDiffers)}, not to ${replica}. So it has no record of replicating to ${replica}, which holds transactions up to ${String(verdict.replica)}, and it may be older than the replica.`,
    replaced: `The database at ${where.sqlitePath} is not the one this volume last replicated to ${replica}, at transaction ${String(verdict.local)}: it was replaced, restored or lost writes since, so it may be older than the replica, which holds transactions up to ${String(verdict.replica)}.`,
  }[verdict.reason];
  return [
    finding,
    "Replicating it would make it the replica's newest state, and the writes after it would remain only in the replica's history, which expires. Replication has not started, and the bucket is unchanged.",
    `To run this database, start it under a new S3_PREFIX, as "Start a backup under a new prefix" in deploy/README.md describes: ${GUIDE}`,
    `To run the replica's newest state instead, remove ${where.sqlitePath} with its -wal and -shm files, and the next start restores it from the bucket.`,
    "To make this database the replica's newest state anyway, start once with MARFA_REPLACE_NEWER_REPLICA=true.",
  ].join("\n");
}
