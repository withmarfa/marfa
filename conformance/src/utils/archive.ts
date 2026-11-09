import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * A `marfa-archive-v0`, read and built here rather than taken from the server.
 *
 * An archive is a plain tar: `manifest.json`, then `instance.ndjson.gz`,
 * `items.ndjson.gz` and `edges.ndjson.gz`, each a gzip-compressed line file,
 * then a raw `blobs/<hash>` entry for each blob it carries.
 *
 * Most archive fixtures post back what `GET /export?format=archive` produced,
 * which keeps the round trip honest. A few preconditions cannot be arranged
 * that way, such as a row under a source no key may hold, a row in a state its
 * type's lifecycle cannot produce, or a blob larger than the request cap that
 * nothing on the instance names yet, so those archives are built here.
 *
 * USTAR, written out rather than taken from a dependency: the suite carries no
 * tar library and needs a few entries with no links, no directories and no
 * long names.
 */

const BLOCK = 512;

/** One regular file in the tar. */
export interface ArchiveFile {
  /** Path inside the archive, such as `manifest.json`. */
  name: string;
  body: string | Uint8Array;
}

/** The three line files, each written as `<name>.ndjson.gz`. */
export type LineFile = "instance" | "items" | "edges";

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(file: ArchiveFile, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(file.name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, "ascii");
  // The checksum is the sum of every header byte, with its own field read as
  // eight spaces.
  block.write("        ", 148, 8, "ascii");
  block.write("0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

/** A plain tar carrying `files`, in the order given. */
export function tar(files: ArchiveFile[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const file of files) {
    const body =
      typeof file.body === "string"
        ? Buffer.from(file.body, "utf8")
        : Buffer.from(file.body);
    parts.push(header(file, body.length));
    parts.push(body);
    const remainder = body.length % BLOCK;
    if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return new Uint8Array(Buffer.concat(parts));
}

/** The line file `name`, holding `body`, as an archive carries it. */
export function lineFile(
  name: LineFile,
  body: string | Uint8Array,
): ArchiveFile {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return { name: `${name}.ndjson.gz`, body: new Uint8Array(gzipSync(bytes)) };
}

/** Lines of JSON, one per value, ending with a newline when there is any. */
export function ndjson(values: unknown[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join("");
}

/**
 * The size field of a header: octal digits, ended by a NUL or a space and
 * perhaps left-padded with spaces, or for a member of 8 GiB or more, the
 * base-256 form, whose first byte has its top bit set.
 */
function sizeOf(name: string, field: Buffer): number {
  const first = field[0] ?? 0;
  if (first & 0x80) {
    let size = 0;
    for (const byte of field.subarray(1)) size = size * 256 + byte;
    return size;
  }
  const text = field.toString("ascii");
  const size = parseInt(text.replace(/\0.*$/, "").trim(), 8);
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(
      `tar entry ${name} has an unreadable size field: ${JSON.stringify(text)}`,
    );
  }
  return size;
}

/** Every member of an archive, in the order it carries them. */
export function listEntries(
  archive: Uint8Array,
): { name: string; body: Buffer }[] {
  const bytes = Buffer.from(archive);
  const entries: { name: string; body: Buffer }[] = [];
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    // A header whose name is empty is the first of the two closing blocks.
    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break;
    const size = sizeOf(name, block.subarray(124, 136));
    const body = offset + BLOCK;
    entries.push({ name, body: bytes.subarray(body, body + size) });
    offset = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/**
 * The named member as text, or null for a name the archive does not carry, so
 * the caller can say so rather than read a member it did not ask for.
 */
export function readEntry(archive: Uint8Array, name: string): string | null {
  const found = listEntries(archive).find((entry) => entry.name === name);
  return found ? found.body.toString("utf8") : null;
}

/** The text of a line file, decompressed, or null where the archive lacks it. */
export function readLineFile(
  archive: Uint8Array,
  name: LineFile,
): string | null {
  const found = listEntries(archive).find(
    (entry) => entry.name === `${name}.ndjson.gz`,
  );
  return found ? gunzipSync(found.body).toString("utf8") : null;
}

/** Each line of a line file, parsed. */
export function archiveLines<T = Record<string, unknown>>(
  archive: Uint8Array,
  name: LineFile,
): T[] {
  return (readLineFile(archive, name) ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

/** The parsed manifest, or an empty object where the archive has none. */
export function archiveManifest<T = Record<string, unknown>>(
  archive: Uint8Array,
): T {
  return JSON.parse(readEntry(archive, "manifest.json") ?? "{}") as T;
}

/** One `items.ndjson.gz` line: the row, and the metadata layer beside it. */
export interface ArchiveItem {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  source: string;
  source_id?: string;
  version?: number;
  state?: string;
  occurred_at?: string;
}

/** A blob entry: its bytes, under the name the restore checks them against. */
export interface ArchiveBlob {
  data: Uint8Array;
  mime_type: string;
  /** The name the entry carries when it is not the bytes' own hash: an
   *  entry the restore must leave out. */
  named?: string;
}

/** `sha256:<hex>` over the bytes, the name a blob entry carries. */
export function blobHash(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/**
 * A minimal version 0 archive: `items`, and the `blobs` and type registrations
 * given. Each line file is written even when empty, so a restore can tell a
 * damaged archive from an empty one. `reshape` takes the manifest as built and
 * answers the one written, for a case that needs a manifest the server would
 * not write.
 */
export function itemsArchive(
  items: ArchiveItem[],
  blobs: ArchiveBlob[] = [],
  types: Record<string, unknown>[] = [],
  reshape: (manifest: Record<string, unknown>) => unknown = (manifest) =>
    manifest,
): Uint8Array {
  const manifest = {
    version: 0,
    format: "marfa-archive-v0",
    created_at: new Date().toISOString(),
    item_count: items.length,
    edge_count: 0,
    blob_count: blobs.length,
    type_count: types.length,
    edge_type_count: 0,
    blobs: Object.fromEntries(
      blobs.map((blob) => [
        blob.named ?? blobHash(blob.data),
        { mime_type: blob.mime_type, size_bytes: blob.data.length },
      ]),
    ),
    missing_blobs: {},
  };
  // Each row lends what it names among the blobs carried, as an export
  // writes a row whose writer sent the bytes.
  const carried = blobs.map((blob) => blob.named ?? blobHash(blob.data));
  return tar([
    {
      name: "manifest.json",
      body: JSON.stringify(reshape(manifest), null, 2),
    },
    lineFile("instance", ndjson(types.map((type) => ({ type })))),
    lineFile(
      "items",
      ndjson(
        items.map((item) => ({
          item,
          metadata: { tags: [], extensions: {} },
          lending_blobs: carried.filter((hash) =>
            JSON.stringify(item).includes(hash.slice("sha256:".length)),
          ),
        })),
      ),
    ),
    lineFile("edges", ""),
    ...blobs.map((blob) => ({
      name: `blobs/${blob.named ?? blobHash(blob.data)}`,
      body: blob.data,
    })),
  ]);
}
