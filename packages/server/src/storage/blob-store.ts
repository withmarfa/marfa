import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { generateId } from "@withmarfa/shared";
import {
  boundBlobRead,
  DEFAULT_BLOB_READ_IDLE_TIMEOUT_MS,
} from "./blob-read.js";
import type { BlobStoreKind } from "./interface.js";

/**
 * A place bytes live. Four verbs on a content hash, so a new kind of store
 * is four functions; plus the identity the location log keys on, and a
 * link where the store can mint one itself.
 *
 * A store never lists what it holds. The location log says which stores
 * hold which blob, so a question about a store's contents is a question
 * to the log answered by `has`, and nothing here needs an enumeration that
 * an object store would page and a disk would walk.
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
   * Store bytes under their hash. A stream source is hashed before it is
   * kept and refused if it does not hash to `hash`; a path source is a file
   * the caller has just hashed itself, which the disk store moves into
   * place and the object store uploads as it is. Idempotent: bytes already
   * under this name are left alone.
   */
  put(hash: string, source: BlobSource): Promise<void>;
  /**
   * The bytes, or a range of them, as a stream. `null` when the store is
   * reachable and holds no such blob; a store that cannot be reached rejects
   * with {@link BlobStoreUnreachable}, because it says nothing of the blob.
   * Once `signal` aborts, the store gives up the request and rejects.
   */
  get(
    hash: string,
    range?: ByteRange,
    signal?: AbortSignal,
  ): Promise<BlobRead | null>;
  /**
   * Presence, with the size the store reports. `null` when the store is
   * reachable and holds no such blob; a store that cannot be reached rejects
   * with {@link BlobStoreUnreachable}. Once `signal` aborts, the store gives
   * up the request and rejects.
   */
  has(
    hash: string,
    signal?: AbortSignal,
  ): Promise<{ size_bytes: number } | null>;
  /**
   * Idempotent: an absent blob is not an error. A store that cannot be
   * reached rejects with {@link BlobStoreUnreachable}, because its bytes
   * are then not gone.
   */
  delete(hash: string): Promise<void>;
  /**
   * A time-limited link a client fetches the bytes from without a
   * credential and without the instance in the path, answering them with
   * `mimeType` as a download (`blobDisposition`), whatever the store holds
   * the object under. Only a store that can sign its own links has one;
   * the instance serves a link for the rest.
   */
  link?(hash: string, ttlSeconds: number, mimeType: string): Promise<string>;
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

/**
 * Thrown by a store that cannot be reached, or that is not the store the
 * instance attached: a folder that went away, a mount point left empty by a
 * drive that did not mount, a folder another store marked. Every name is
 * absent there, so an absent name proves nothing about a copy.
 */
export class BlobStoreUnreachable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BlobStoreUnreachable";
  }
}

/** The `sha256:<hex>` form, without the prefix. */
export function bareHex(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

/**
 * How every answer carrying a blob's bytes asks to be handled: as a file to
 * save, never a page to render. The bytes' type is whatever an uploader sent,
 * so an HTML or SVG blob shown inline would run as a page of whichever
 * origin served it, the instance's own included. The name is the hex alone,
 * so nothing an uploader chose reaches the header.
 */
export function blobDisposition(hash: string): string {
  return `attachment; filename="${bareHex(hash)}"`;
}

/**
 * The policy the instance's own answers carry with a blob's bytes, so a
 * browser that renders them anyway, ignoring the disposition, runs them in
 * an opaque origin with nothing loaded.
 */
export const BLOB_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'";

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

/**
 * Write a stream source to `path` while hashing it, and refuse it if it
 * does not hash to its name. The file is removed on refusal, so a caller
 * that gets past this call holds a file it may name `hash`.
 */
export async function spoolVerified(
  path: string,
  hash: string,
  source: { stream: Readable; size_bytes: number },
): Promise<void> {
  const hashing = new HashingTransform();
  try {
    await pipeline(source.stream, hashing, createWriteStream(path));
    const actual = hashing.digest();
    if (actual !== hash || hashing.bytes !== source.size_bytes) {
      throw new BlobHashMismatch(hash, actual);
    }
  } catch (err) {
    await rm(path, { force: true });
    throw err;
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

  constructor(
    basePath: string,
    private readonly readIdleTimeoutMs = DEFAULT_BLOB_READ_IDLE_TIMEOUT_MS,
  ) {
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
    await spoolVerified(spool, hash, source);
    await moveIntoPlace(spool, final);
  }

  async get(
    hash: string,
    range?: ByteRange,
    signal?: AbortSignal,
  ): Promise<BlobRead | null> {
    signal?.throwIfAborted();
    // Opened here, not by the stream: a stream opens its path later, and one
    // destroyed unread then throws uncaught if the file went in between.
    let handle: FileHandle;
    try {
      handle = await open(this.pathFor(hash), "r");
    } catch (err) {
      if (!isEnoent(err)) throw err;
      await this.confirmReachable();
      return null;
    }
    let size: number;
    try {
      // A file system call cannot be called off, so a request given up
      // while it ran closes what it opened.
      signal?.throwIfAborted();
      size = (await handle.stat()).size;
      signal?.throwIfAborted();
    } catch (err) {
      await handle.close();
      throw err;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    if (length === 0) {
      await handle.close();
      return {
        stream: Readable.from([]),
        size_bytes: size,
        offset: start,
        length,
      };
    }
    try {
      const stream = boundBlobRead(
        handle.createReadStream({ start, end }),
        this.readIdleTimeoutMs,
      );
      return { stream, size_bytes: size, offset: start, length };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async has(
    hash: string,
    signal?: AbortSignal,
  ): Promise<{ size_bytes: number } | null> {
    signal?.throwIfAborted();
    let size: number;
    try {
      size = (await stat(this.pathFor(hash))).size;
    } catch (err) {
      if (!isEnoent(err)) throw err;
      await this.confirmReachable();
      return null;
    }
    signal?.throwIfAborted();
    return { size_bytes: size };
  }

  async delete(hash: string): Promise<void> {
    try {
      await unlink(this.pathFor(hash));
    } catch (err) {
      if (!isEnoent(err)) throw err;
      await this.confirmReachable();
    }
  }

  /**
   * Called when a name came back absent, so that only a store that is
   * present answers "absent". The marker is what says so: it is written
   * when the folder first becomes a store and is never removed, so a
   * folder without it, or with another store's, is not this store.
   */
  private async confirmReachable(): Promise<void> {
    const markerPath = join(this.locator, MARKER);
    let raw: string;
    try {
      raw = await readFile(markerPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new BlobStoreUnreachable(
          `the disk store's folder or its marker at ${markerPath} is missing`,
        );
      }
      throw err;
    }
    if (markerId(raw) !== this.storeId) {
      throw new BlobStoreUnreachable(
        `the marker at ${markerPath} does not name the store attached here`,
      );
    }
  }
}

function markerId(raw: string): string | null {
  try {
    const { id } = JSON.parse(raw) as { id?: unknown };
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Rename a spooled file to its final name. Content addressing means a file
 * already there holds these same bytes, so losing the race is a discard,
 * not a failure.
 *
 * The bytes are synced before the name exists and the name after, so that
 * a row naming the blob, committed once this returns, never outlives the
 * file in an image of the disk taken at any instant.
 */
async function moveIntoPlace(from: string, to: string): Promise<void> {
  try {
    await stat(to);
    await rm(from, { force: true });
    return;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  await syncPath(from);
  await rename(from, to);
  await syncPath(dirname(to), true);
}

/**
 * Flush a file, or a directory's entries, to the disk. A directory cannot
 * be opened on every platform, and where it cannot, there is nothing to
 * flush and the rename stands as the platform makes it durable.
 */
async function syncPath(path: string, directory = false): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if (directory && isUnopenableDirectory(err)) return;
    throw err;
  }
  try {
    await handle.sync();
  } catch (err) {
    if (directory && isUnopenableDirectory(err)) return;
    throw err;
  } finally {
    await handle.close();
  }
}

function isUnopenableDirectory(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EISDIR" || code === "EPERM" || code === "EINVAL";
}

export function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
