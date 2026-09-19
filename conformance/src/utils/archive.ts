import { gzipSync } from "node:zlib";

/**
 * A `marfa-archive-v2` built here rather than exported from the server.
 *
 * Every other archive fixture posts back what `GET /export?format=archive`
 * produced, which keeps the round trip honest and needs no tar of our own.
 * One precondition cannot be arranged that way: a connector's copy of an
 * external record. No door mints a row whose `source` carries the
 * `connector:` prefix — `POST /keys` refuses the prefix and `POST /items`
 * stamps the credential's own source over anything the body claims — so the
 * server can never be asked to export one.
 *
 * `POST /admin/restore-archive` writes `item.source` through verbatim, which
 * makes an archive the one door that does mint one. That is what this builds,
 * and it is why the doors behind that precondition are assertable at all.
 *
 * USTAR, written out rather than taken from a dependency: the suite carries
 * no tar library and this needs four small entries with no links, no
 * directories and no long names.
 */

const BLOCK = 512;

/** One regular file in the tar. */
export interface ArchiveFile {
  /** Path inside the archive, e.g. `items.ndjson`. */
  name: string;
  body: string;
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
    const body = Buffer.from(file.body, "utf8");
    parts.push(header(file, body.length));
    parts.push(body);
    const remainder = body.length % BLOCK;
    if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder, 0));
  }
  // Two zero blocks close the archive.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
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

/**
 * A minimal version 2 archive carrying `items` and nothing else.
 *
 * `edges.ndjson` and `types.ndjson` are emitted empty rather than omitted,
 * which is what the server's own exporter does and what lets the restore
 * tell a damaged archive from an empty one.
 */
export function itemsArchive(items: ArchiveItem[]): Uint8Array {
  const manifest = {
    version: 2,
    format: "marfa-archive-v2",
    created_at: new Date().toISOString(),
    item_count: items.length,
    edge_count: 0,
    blob_count: 0,
    type_count: 0,
    edge_type_count: 0,
    blobs: {},
  };
  const lines = items
    .map((item) =>
      JSON.stringify({ item, metadata: { tags: [], extensions: {} } }),
    )
    .join("\n");
  return tarGz([
    { name: "manifest.json", body: JSON.stringify(manifest, null, 2) },
    { name: "items.ndjson", body: lines === "" ? "" : `${lines}\n` },
    { name: "edges.ndjson", body: "" },
    { name: "types.ndjson", body: "" },
  ]);
}
