import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * An archive at version 1, read and built here rather than taken from the server.
 *
 * An archive is a plain tar: `manifest.json`, then `instance.ndjson.gz`,
 * `items.ndjson.gz`, `edges.ndjson.gz` and `rows.ndjson.gz`, each a
 * gzip-compressed line file, then a raw `blobs/<hash>` entry for each blob it
 * carries.
 *
 * Most archive fixtures post back what `GET /export?format=archive` produced,
 * which keeps the round trip honest. A few preconditions cannot be arranged
 * that way, such as an item under a source no key may hold, an item in a state its
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

/** The four line files, each written as `<name>.ndjson.gz`. */
export type LineFile = "instance" | "items" | "edges" | "rows";

/** The version a restore reads, and the build that wrote the archive. */
export const ARCHIVE_VERSION = 1;

/**
 * A manifest a restore accepts for an archive holding nothing, with `fields`
 * laid over it: the counts every manifest carries, each zero.
 */
export function emptyManifest(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: ARCHIVE_VERSION,
    written_by: "marfa-server 0.0.0",
    created_at: new Date().toISOString(),
    item_count: 0,
    edge_count: 0,
    row_count: 0,
    blob_count: 0,
    type_count: 0,
    edge_type_count: 0,
    type_icon_count: 0,
    source_count: 0,
    setting_count: 0,
    connector_state_count: 0,
    connector_agreement_count: 0,
    blobs: {},
    missing_blobs: {},
    ...fields,
  };
}

/** The manifest's count of each line file's lines, for those it counts. */
const COUNTED: Partial<Record<LineFile, string>> = {
  items: "item_count",
  edges: "edge_count",
  rows: "row_count",
};

/** Each kind of instance line, with the manifest field that counts it. */
const INSTANCE_KINDS: Record<string, string> = {
  type: "type_count",
  edge_type: "edge_type_count",
  type_icon: "type_icon_count",
  source: "source_count",
  setting: "setting_count",
  connector_state: "connector_state_count",
  connector_agreement: "connector_agreement_count",
};

/** The manifest's count of each kind of line in `instance.ndjson.gz`. */
function instanceCounts(text: string): Record<string, number> {
  const counts = Object.fromEntries(
    Object.values(INSTANCE_KINDS).map((field) => [field, 0]),
  ) as Record<string, number>;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const held = JSON.parse(line) as Record<string, unknown>;
    for (const [kind, field] of Object.entries(INSTANCE_KINDS)) {
      if (kind in held) counts[field]! += 1;
    }
  }
  return counts;
}

function lineCount(text: string): number {
  return text.split("\n").filter((line) => line !== "").length;
}

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

/**
 * The first `entries` members of an archive and nothing after them, with no
 * closing blocks: the archive as a connection that dropped between two files
 * leaves it, or `into` bytes further for one that dropped inside the next.
 */
export function cutAfter(
  archive: Uint8Array,
  entries: number,
  into = 0,
): Uint8Array {
  const bytes = Buffer.from(archive);
  let offset = 0;
  for (let at = 0; at < entries; at += 1) {
    const size = sizeOf("entry", bytes.subarray(offset + 124, offset + 136));
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return new Uint8Array(bytes.subarray(0, offset + into));
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

/**
 * The archive with one line file's text replaced by what `edit` makes of it,
 * and the manifest's counts of that file's lines kept in step, every other
 * member kept as it was, in its place.
 */
export function editLineFile(
  archive: Uint8Array,
  name: LineFile,
  edit: (text: string) => string,
): Uint8Array {
  const entries = listEntries(archive);
  const found = entries.find((entry) => entry.name === `${name}.ndjson.gz`);
  const text = edit(found ? gunzipSync(found.body).toString("utf8") : "");
  const counted = COUNTED[name];
  return tar(
    entries.map((entry) => {
      if (entry.name === `${name}.ndjson.gz`) return lineFile(name, text);
      if (
        entry.name === "manifest.json" &&
        (counted !== undefined || name === "instance")
      ) {
        const manifest = JSON.parse(entry.body.toString("utf8")) as Record<
          string,
          unknown
        >;
        if (counted !== undefined && counted in manifest) {
          manifest[counted] = lineCount(text);
        }
        if (name === "instance") {
          for (const [field, count] of Object.entries(instanceCounts(text))) {
            if (field in manifest) manifest[field] = count;
          }
        }
        return { name: entry.name, body: JSON.stringify(manifest) };
      }
      return { name: entry.name, body: entry.body };
    }),
  );
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

/** One `items.ndjson.gz` line: the item, and the metadata layer beside it. */
export interface ArchiveItem {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  source: string;
  source_id?: string;
  version?: number;
  state?: string;
  created_at?: string;
  updated_at?: string;
  last_activity_at?: string;
  occurred_at?: string;
}

/** The fields every item line carries besides its identity and properties. */
export function itemFields(
  created_at = new Date().toISOString(),
): Required<
  Pick<
    ArchiveItem,
    | "version"
    | "state"
    | "created_at"
    | "updated_at"
    | "last_activity_at"
    | "occurred_at"
  >
> {
  return {
    version: 1,
    state: "active",
    created_at,
    updated_at: created_at,
    last_activity_at: created_at,
    occurred_at: created_at,
  };
}

function whole(item: ArchiveItem): ArchiveItem {
  return { ...itemFields(item.created_at), ...item };
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
 * A minimal archive: `items`, and the `blobs` and type registrations
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
  const manifest = emptyManifest({
    item_count: items.length,
    blob_count: blobs.length,
    type_count: types.length,
    blobs: Object.fromEntries(
      blobs.map((blob) => [
        blob.named ?? blobHash(blob.data),
        { mime_type: blob.mime_type, size_bytes: blob.data.length },
      ]),
    ),
  });
  // Each item lends what it names among the blobs carried, as an export
  // writes an item whose writer sent the bytes.
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
          item: whole(item),
          metadata: { tags: [], extensions: {} },
          lending_blobs: carried.filter((hash) =>
            JSON.stringify(item).includes(hash.slice("sha256:".length)),
          ),
        })),
      ),
    ),
    lineFile("edges", ""),
    lineFile("rows", ""),
    ...blobs.map((blob) => ({
      name: `blobs/${blob.named ?? blobHash(blob.data)}`,
      body: blob.data,
    })),
  ]);
}
