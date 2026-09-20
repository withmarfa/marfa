import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { generateId } from "@withmarfa/shared";
import type { BlobStoreKind } from "./interface.js";

/**
 * A place bytes live. Four verbs on a content hash, so a new kind of store
 * is four functions; plus the identity the location log keys on, and a
 * link where the store can mint one itself.
 *
 * A store never lists what it holds. The location log says which stores
 * hold which blob, the integrity check asks `has` for every row the log
 * names, and nothing here needs an enumeration that an object store would
 * page and a disk would walk.
 */
export interface BlobStore {
  /** From the store's own marker, not the configuration: a fresh folder
   *  is a fresh store with no claimed copies. Set by `attach()`. */
  readonly id: string;
  readonly kind: BlobStoreKind;
  /** Where the store is, for a person. Never a credential. */
  readonly locator: string;
  /** Read the marker, or write one on first use. Called once at boot. */
  attach(): Promise<void>;
  /**
   * Store bytes under their hash. A stream source is hashed on the way in
   * and refused if it does not hash to `hash`; a path source is a file the
   * caller has just hashed itself, which the disk store moves into place.
   */
  put(hash: string, source: BlobSource): Promise<void>;
  /** The bytes, or a range of them, as a stream. `null` when absent. */
  get(hash: string, range?: ByteRange): Promise<BlobRead | null>;
  /** Presence, with the size the store reports. `null` when absent. */
  has(hash: string): Promise<{ size_bytes: number } | null>;
  /** Idempotent: an absent blob is not an error. */
  delete(hash: string): Promise<void>;
  /**
   * A time-limited link a client fetches the bytes from without a
   * credential and without the instance in the path. Only a store that can
   * sign its own links has one; the instance serves a link for the rest.
   */
  link?(hash: string, ttlSeconds: number): Promise<string>;
}

export type BlobSource =
  | { stream: Readable; size_bytes: number }
  | { path: string; size_bytes: number };

/** Inclusive byte offsets within a blob. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface BlobRead {
  stream: Readable;
  /** The whole blob's size, whatever range was asked for. */
  size_bytes: number;
  /** The first byte the stream carries. */
  offset: number;
  /** How many bytes the stream carries. */
  length: number;
}

/**
 * Thrown by a store when the bytes it was handed do not hash to their
 * name. The bytes are not kept.
 */
export class BlobHashMismatch extends Error {
  constructor(hash: string, actual: string) {
    super(`bytes named ${hash} hashed to ${actual}`);
    this.name = "BlobHashMismatch";
  }
}

/** The `sha256:<hex>` form, without the prefix. */
export function bareHex(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

/**
 * Resolve one `Range` header against a size. `undefined` for no header or
 * a header this does not serve (a suffix range, several ranges), `null` for
 * a range the blob cannot satisfy, else the inclusive bounds.
 */
export function resolveRange(
  header: string | undefined,
  sizeBytes: number,
): ByteRange | null | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === "" ? sizeBytes - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return undefined;
  }
  if (start >= sizeBytes || end < start) return null;
  return { start, end: Math.min(end, sizeBytes - 1) };
}

/**
 * A transform that hashes and counts what passes through it, so a store
 * can verify a stream source without holding it.
 */
export class HashingTransform extends Transform {
  private readonly hash = createHash("sha256");
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  digest(): string {
    return `sha256:${this.hash.digest("hex")}`;
  }
}

const MARKER = ".marfa-store";
const SPOOL_DIR = "tmp";

/**
 * Bytes on the local disk, one file per hash under a two-level directory
 * keyed on the first four hex characters, beside a marker naming the store
 * and a spool directory uploads are written into before they are named.
 */
export class DiskBlobStore implements BlobStore {
  readonly kind = "disk" as const;
  readonly locator: string;
  private storeId: string | null = null;

  constructor(basePath: string) {
    this.locator = resolve(basePath);
  }

  get id(): string {
    if (this.storeId === null) {
      throw new Error("DiskBlobStore: attach() before reading the id");
    }
    return this.storeId;
  }

  /** Where the upload route spools a body while it hashes it. On this
   *  store's filesystem so the final move is a rename, never a copy. */
  get spoolDir(): string {
    return join(this.locator, SPOOL_DIR);
  }

  async attach(): Promise<void> {
    await mkdir(this.spoolDir, { recursive: true });
    const markerPath = join(this.locator, MARKER);
    try {
      const raw = await readFile(markerPath, "utf8");
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed.id !== "string" || parsed.id.length === 0) {
        throw new Error(`the store marker at ${markerPath} names no id`);
      }
      this.storeId = parsed.id;
    } catch (err) {
      if (!isEnoent(err)) throw err;
      const id = generateId();
      await writeFile(markerPath, JSON.stringify({ id }) + "\n", {
        flag: "wx",
      });
      this.storeId = id;
    }
    // A spool left by a process that died mid-upload is bytes nothing will
    // ever name. Each boot starts with an empty spool.
    for (const entry of await readdir(this.spoolDir)) {
      await rm(join(this.spoolDir, entry), { force: true });
    }
  }

  /** A fresh path in the spool for one upload to write into. */
  spoolPath(): string {
    return join(this.spoolDir, generateId());
  }

  private pathFor(hash: string): string {
    const hex = bareHex(hash);
    const path = resolve(join(this.locator, hex.slice(0, 4), hex));
    if (!path.startsWith(this.locator + "/")) {
      throw new Error("DiskBlobStore: hash escapes the store");
    }
    return path;
  }

  async put(hash: string, source: BlobSource): Promise<void> {
    const final = this.pathFor(hash);
    await mkdir(join(final, ".."), { recursive: true });
    if ("path" in source) {
      await moveIntoPlace(source.path, final);
      return;
    }
    const spool = this.spoolPath();
    const hashing = new HashingTransform();
    try {
      await pipeline(source.stream, hashing, createWriteStream(spool));
      const actual = hashing.digest();
      if (actual !== hash || hashing.bytes !== source.size_bytes) {
        throw new BlobHashMismatch(hash, actual);
      }
    } catch (err) {
      await rm(spool, { force: true });
      throw err;
    }
    await moveIntoPlace(spool, final);
  }

  async get(hash: string, range?: ByteRange): Promise<BlobRead | null> {
    const path = this.pathFor(hash);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const stream =
      length === 0 ? Readable.from([]) : createReadStream(path, { start, end });
    return { stream, size_bytes: size, offset: start, length };
  }

  async has(hash: string): Promise<{ size_bytes: number } | null> {
    try {
      return { size_bytes: (await stat(this.pathFor(hash))).size };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async delete(hash: string): Promise<void> {
    try {
      await unlink(this.pathFor(hash));
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
}

/**
 * Rename a spooled file to its final name. Content addressing means a file
 * already there holds these same bytes, so losing the race is a discard,
 * not a failure.
 */
async function moveIntoPlace(from: string, to: string): Promise<void> {
  try {
    await stat(to);
    await rm(from, { force: true });
    return;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  await rename(from, to);
}

export function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
