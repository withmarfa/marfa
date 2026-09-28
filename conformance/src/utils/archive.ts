import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * A `marfa-archive-v2` built here rather than exported from the server.
 *
 * Every other archive fixture posts back what `GET /export?format=archive`
 * produced, which keeps the round trip honest and needs no tar of our own.
 * Three preconditions cannot be arranged that way. A connector's copy of an
 * external record: no door mints a row whose `source` carries the
 * `connector:` prefix — `POST /keys` refuses the prefix as a key's own source
 * and as a claim, and `POST /items` refuses a source the key does not claim —
 * so the server can never be asked to export one, while
 * `POST /admin/restore-archive` writes `item.source` through verbatim and is
 * the one door that does mint one. A row in a state its type's lifecycle cannot produce, which no door
 * writes and the restore refuses. And a blob larger than the request cap
 * that nothing on the instance names yet, which only an archive carries in.
 *
 * USTAR, written out rather than taken from a dependency: the suite carries
 * no tar library and this needs a few entries with no links, no directories
 * and no long names.
 */

const BLOCK = 512;

/** One regular file in the tar. */
export interface ArchiveFile {
  /** Path inside the archive, e.g. `items.ndjson`. */
  name: string;
  body: string | Uint8Array;
}

function octal(value: number, width: number): string {
  // `width - 1` digits and a NUL, which is the conservative spelling every
  // reader accepts; the trailing-space form is equally legal and not worth
  // the choice.
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(file: ArchiveFile, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(file.name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii"); // uid
  block.write(octal(0, 8), 116, 8, "ascii"); // gid
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii"); // checksum placeholder
  block.write("0", 156, 1, "ascii"); // typeflag: regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

  // The checksum is the unsigned sum of every header byte with its own field
  // read as eight spaces, which is what the placeholder above is for.
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

/** A gzip-compressed tar carrying `files`, in the order given. */
export function tarGz(files: ArchiveFile[]): Uint8Array {
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
  // Two zero blocks close the archive.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

/**
 * The named member of a `tar.gz` the server produced, as text.
 *
 * The writer above exists because one precondition cannot be exported; this
 * reader exists because one assertion cannot be made over HTTP. The archive
 * manifest is a wire artifact the server emits and no route echoes, so the
 * only way to hold it to anything is to open the bytes.
 *
 * Same USTAR subset as the writer, read rather than written: a 512-byte
 * header, an octal size at offset 124, the body padded to the next block.
 * Entries the archive carries that this is not asked for are skipped by
 * size, and a name that never appears answers null so the caller can say so
 * rather than reading a member it did not ask for.
 */
export function readTarGzEntry(
  archive: Uint8Array,
  name: string,
): string | null {
  const tar = gunzipSync(Buffer.from(archive));
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two zero blocks close the archive, and one is enough to stop on: a
    // header whose name field is empty is the end of the entries.
    const entry = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (entry === "") return null;
    // The size field is eleven octal digits and a terminator, but the
    // terminator is a NUL in one legal spelling and a space in another, and
    // either may be left-padded with spaces. Cutting at the first space
    // reads a left-padded field as empty, and `parseInt("", 8)` is `NaN` —
    // which walks the loop off the end of the archive and answers "no such
    // member" for a member that is there. The throw is what stops that
    // being a silent wrong answer; it also catches the base-256 encoding a
    // member of 8 GiB or more would use, which this reader does not read.
    const field = header.subarray(124, 136).toString("ascii");
    const size = parseInt(field.replace(/\0.*$/, "").trim(), 8);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(
        `tar entry ${entry} has an unreadable size field: ${JSON.stringify(field)}`,
      );
    }
    const body = offset + BLOCK;
    if (entry === name) {
      return tar.subarray(body, body + size).toString("utf8");
    }
    offset = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return null;
}

/** One `items.ndjson` line: the row, and the metadata layer beside it. */
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
 * A minimal version 2 archive carrying `items`, and the `blobs` and type
 * registrations given, and nothing else.
 *
 * `edges.ndjson`, and `types.ndjson` when no type is given, are emitted
 * empty rather than omitted, which is what the server's own exporter does and
 * what lets the restore tell a damaged archive from an empty one. The blob
 * entries sit between the items and the edges, so a member follows every
 * blob and a blob whose padding was wrong would put the reader off that
 * member.
 */
export function itemsArchive(
  items: ArchiveItem[],
  blobs: ArchiveBlob[] = [],
  types: Record<string, unknown>[] = [],
): Uint8Array {
  const manifest = {
    version: 2,
    format: "marfa-archive-v2",
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
  };
  const lines = items
    .map((item) =>
      JSON.stringify({ item, metadata: { tags: [], extensions: {} } }),
    )
    .join("\n");
  return tarGz([
    { name: "manifest.json", body: JSON.stringify(manifest, null, 2) },
    { name: "items.ndjson", body: lines === "" ? "" : `${lines}\n` },
    ...blobs.map((blob) => ({
      name: `blobs/${blob.named ?? blobHash(blob.data)}`,
      body: blob.data,
    })),
    { name: "edges.ndjson", body: "" },
    {
      name: "types.ndjson",
      body: types.map((type) => `${JSON.stringify({ type })}\n`).join(""),
    },
  ]);
}
