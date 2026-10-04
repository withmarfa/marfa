/**
 * Reading a restore archive off its spool in memory that does not grow with
 * the archive.
 *
 * Every entry the restore uses goes to a spool on the disk store's
 * filesystem, as the body did, and every entry it does not use is read past
 * without being kept. The line files are then read a line at a time, as
 * often as the restore needs to, so the largest text held is one line.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { z } from "@hono/zod-openapi";
import * as tar from "tar-stream";
import { MarfaError, ErrorCode, isValidBlobHash } from "@withmarfa/shared";
import { HashingTransform } from "../storage/blob-store.js";
import { constantTimeEqual } from "../utils/crypto.js";

/**
 * The largest JSON text the restore parses at once: the manifest, all of
 * `types.ndjson`, or one line of `items.ndjson` or `edges.ndjson`.
 *
 * Parsing takes several times the text's size, so this is what bounds the
 * restore's memory. It is four times the bulk door's default body cap,
 * room for an item written there at its largest together with its history,
 * and a manifest naming several hundred thousand blobs.
 */
export const MAX_ARCHIVE_TEXT_BYTES = 64 * 1024 * 1024;

/**
 * What the restore reads out of `manifest.json`, which is narrower than what
 * the export writes.
 *
 * `ArchiveManifest` in `routes/export.ts` is the writer's own declaration
 * and the authority on the format. This one stops at the fields the restore
 * consults: `version`, which it refuses, and `blobs`, whose mime type each
 * blob entry is stored under. Widening it to match the writer would have it
 * claim fields of every archive ever written, which is a claim nothing here
 * can keep.
 */
const archiveManifestSchema = z.object({
  version: z.literal(0),
  blobs: z.record(
    z.string(),
    z.object({
      mime_type: z.string(),
      size_bytes: z.number().int().nonnegative(),
    }),
  ),
});
type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

export interface PendingBlob {
  hash: string;
  mimeType: string;
  /** A spool on the disk store's own filesystem holding the entry's bytes,
   *  which hashed to `hash` as they were read. */
  path: string;
  sizeBytes: number;
}

/** The line files the restore reads, each spooled if the archive carries it. */
const LINE_FILES = ["items.ndjson", "edges.ndjson", "types.ndjson"] as const;
type LineFile = (typeof LINE_FILES)[number];

export interface ReadArchive {
  lineFiles: Partial<Record<LineFile, string>>;
  blobs: PendingBlob[];
}

function invalid(message: string, details?: Record<string, unknown>) {
  return new MarfaError(ErrorCode.VALIDATION_ERROR, message, details);
}

function tooLarge(what: string): MarfaError {
  return invalid(
    `Invalid archive: ${what} is larger than ${String(MAX_ARCHIVE_TEXT_BYTES)} bytes, the most the restore reads at once`,
    { limit_bytes: MAX_ARCHIVE_TEXT_BYTES },
  );
}

/** The refusal for a manifest the schema does not take, naming each field. */
function invalidManifest(error: z.ZodError): MarfaError {
  const errors = error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const named = errors.map((e) => e.path || "the manifest itself").join(", ");
  return invalid(`Invalid manifest.json: ${named}`, { errors });
}

function parseManifest(text: string): ArchiveManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("Invalid manifest.json");
  }
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { version?: unknown }).version
      : undefined;
  // Ahead of the shape, because another version's manifest is free to lay
  // its other fields out differently. An archive at another version may name
  // its registrations under keys this build does not read, with no fallback
  // key, so parsing one would drop every registration it carries and answer
  // 200.
  if (typeof version === "number" && version !== 0) {
    throw invalid(
      `Unsupported archive version ${String(version)}. Until the first public release an archive is read only by the build that wrote it, and this build reads version 0 only: restore it into the build that exported it.`,
    );
  }
  const checked = archiveManifestSchema.safeParse(parsed);
  if (!checked.success) throw invalidManifest(checked.error);
  return checked.data;
}

/** A filesystem error, which is a fault here and not a fault in the
 *  archive: Node's own stream and zlib codes carry underscores. */
function isFilesystemError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    /^E[A-Z0-9]+$/.test((err as NodeJS.ErrnoException).code ?? "")
  );
}

/**
 * Read the archive spooled at `body` into spools of its own.
 *
 * `mintSpool` hands out a spool path and records it, so the caller can
 * remove every spool on every outcome, including one whose entry was still
 * being written when a refusal landed.
 */
export async function readArchive(
  body: string,
  mintSpool: () => string,
): Promise<ReadArchive> {
  // Set from a stream callback, which the compiler cannot follow.
  let manifest = null as ArchiveManifest | null;
  const lineFiles: ReadArchive["lineFiles"] = {};
  const blobs: PendingBlob[] = [];
  const seen = new Set<string>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  const input = createReadStream(body);

  const entries = new Promise<void>((resolve, reject) => {
    // Every stream in the pipeline needs its own listener: `pipe` does not
    // forward an error, and a stream without one re-emits it as an
    // unhandled `error` event that ends the process. A body the
    // decompressor or the tar reader cannot parse is a refusal, not a crash.
    const fail = (err: unknown) => {
      reject(
        err instanceof MarfaError || isFilesystemError(err)
          ? err
          : invalid("Invalid archive: expected a gzip-compressed tar"),
      );
    };
    input.on("error", fail);
    gunzip.on("error", fail);
    extract.on("error", fail);

    extract.on("entry", (header, stream, next) => {
      stream.on("error", fail);
      const name = header.name;
      const skip = () => {
        stream.on("end", next);
        stream.resume();
      };

      const blobHash = name.startsWith("blobs/")
        ? name.slice("blobs/".length)
        : undefined;
      const used =
        name === "manifest.json" ||
        (LINE_FILES as readonly string[]).includes(name) ||
        (blobHash !== undefined && isValidBlobHash(blobHash));
      // Only names the restore reads are remembered, so a run of entries
      // under names it does not read costs nothing to step past.
      if (!used) {
        skip();
        return;
      }
      if (seen.has(name)) {
        fail(
          invalid(`Invalid archive: it carries ${name} more than once`, {
            entry: name,
          }),
        );
        return;
      }
      seen.add(name);

      if (name === "manifest.json" || name === "types.ndjson") {
        if ((header.size ?? 0) > MAX_ARCHIVE_TEXT_BYTES) {
          fail(tooLarge(name));
          return;
        }
      }

      if (name === "manifest.json") {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          try {
            manifest = parseManifest(Buffer.concat(chunks).toString("utf-8"));
          } catch (err) {
            fail(err);
            return;
          }
          next();
        });
        return;
      }

      const spool = mintSpool();
      if (blobHash === undefined) {
        pipeline(
          stream,
          new LineLengthGuard(name),
          createWriteStream(spool),
        ).then(() => {
          lineFiles[name as LineFile] = spool;
          next();
        }, fail);
        return;
      }

      // A blob entry is hashed on the way to its spool; one that does not
      // hash to its name is left out, as an entry under a name that is no
      // hash is.
      const hashing = new HashingTransform();
      pipeline(stream, hashing, createWriteStream(spool)).then(async () => {
        if (constantTimeEqual(hashing.digest(), blobHash)) {
          blobs.push({
            hash: blobHash,
            mimeType: "",
            path: spool,
            sizeBytes: hashing.bytes,
          });
        } else {
          await rm(spool, { force: true });
        }
        next();
      }, fail);
    });
    extract.on("finish", resolve);
  });

  input.pipe(gunzip).pipe(extract);
  try {
    await entries;
  } catch (err) {
    // A refusal mid-read leaves the decompressor holding the body and the
    // reader waiting on an entry that will never be taken; both are let go
    // here rather than left for the collector.
    input.destroy();
    gunzip.destroy();
    extract.destroy();
    throw err;
  }

  // Resolved once every entry is read, so a manifest written after the blobs
  // names their types as well as one written first.
  for (const blob of blobs) {
    blob.mimeType =
      manifest?.blobs[blob.hash]?.mime_type ?? "application/octet-stream";
  }
  return { lineFiles, blobs };
}

/**
 * Refuses a line file as soon as one of its lines passes
 * `MAX_ARCHIVE_TEXT_BYTES`, so the spool never holds more of one than that,
 * and `archiveLines` never has more than that to hold.
 */
class LineLengthGuard extends Transform {
  private run = 0;
  private line = 1;

  constructor(private readonly name: string) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0x0a, start);
      const length = (end === -1 ? chunk.length : end) - start;
      if (this.run + length > MAX_ARCHIVE_TEXT_BYTES) {
        done(tooLarge(`${this.name} line ${String(this.line)}`));
        return;
      }
      if (end === -1) {
        this.run += length;
        break;
      }
      this.run = 0;
      this.line += 1;
      start = end + 1;
    }
    done(null, chunk);
  }
}

/** The lines of a spooled line file, one at a time, skipping blank ones. */
export async function* archiveLines(
  path: string | undefined,
): AsyncGenerator<string> {
  if (path === undefined) return;
  let pending: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    let rest = chunk as Buffer;
    for (let end = rest.indexOf(0x0a); end !== -1; end = rest.indexOf(0x0a)) {
      pending.push(rest.subarray(0, end));
      const text = Buffer.concat(pending).toString("utf-8");
      pending = [];
      rest = rest.subarray(end + 1);
      if (text.trim() !== "") yield text;
    }
    if (rest.length > 0) pending.push(rest);
  }
  const text = Buffer.concat(pending).toString("utf-8");
  if (text.trim() !== "") yield text;
}
