/**
 * The tar reader and writer, against inputs the fixtures do not reach.
 *
 * Fixtures mostly ask for `manifest.json`, which the server writes first, so
 * the walk that skips a member by its size, the answer for a name the archive
 * does not carry, and the size fields other tars write are exercised nowhere
 * else. A reader that answered `null` for a member that is present would make
 * an assertion about the manifest pass by default.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  archiveLines,
  archiveManifest,
  blobHash,
  editLineFile,
  itemsArchive,
  lineFile,
  listEntries,
  readEntry,
  readLineFile,
  tar,
} from "./archive.js";

/** The same archive with the first entry's size field written differently. */
function rewriteFirstSize(archive: Uint8Array, field: Buffer): Uint8Array {
  const bytes = Buffer.from(archive);
  bytes.fill(0, 124, 136);
  field.copy(bytes, 124);
  return new Uint8Array(bytes);
}

const three = [
  { name: "manifest.json", body: '{"version":2}' },
  // Exactly one block, so the next header sits at the boundary rather than
  // after padding.
  { name: "notes.txt", body: "x".repeat(512) },
  lineFile("edges", ""),
];

describe("readEntry", () => {
  it("reads the first member", () => {
    expect(readEntry(tar(three), "manifest.json")).toBe('{"version":2}');
  });

  it("skips past earlier members to reach a later one", () => {
    expect(readEntry(tar(three), "notes.txt")).toBe("x".repeat(512));
  });

  it("answers null for a name the archive does not carry", () => {
    expect(readEntry(tar(three), "items.ndjson.gz")).toBeNull();
  });

  it("reads a size field written in the left-padded spelling", () => {
    const archive = rewriteFirstSize(
      tar(three),
      Buffer.from("          15", "ascii"),
    );
    expect(readEntry(archive, "manifest.json")).toBe('{"version":2}');
  });

  it("reads a size written in base-256", () => {
    const field = Buffer.alloc(12, 0);
    field[0] = 0x80;
    field[11] = 13;
    expect(
      readEntry(rewriteFirstSize(tar(three), field), "manifest.json"),
    ).toBe('{"version":2}');
  });

  it("refuses a size it cannot read rather than reporting the member absent", () => {
    const archive = rewriteFirstSize(tar(three), Buffer.from("zz", "ascii"));
    expect(() => readEntry(archive, "manifest.json")).toThrow(
      /unreadable size/,
    );
  });
});

describe("readLineFile", () => {
  it("reads a line file the writer emitted empty, which is not a missing one", () => {
    expect(readLineFile(tar(three), "edges")).toBe("");
    expect(readLineFile(tar(three), "items")).toBeNull();
  });
});

describe("listEntries", () => {
  it("lists every member in the order the archive carries them", () => {
    expect(listEntries(tar(three)).map((e) => e.name)).toEqual([
      "manifest.json",
      "notes.txt",
      "edges.ndjson.gz",
    ]);
  });
});

describe("editLineFile", () => {
  it("replaces one line file's text and keeps every other member in its place", () => {
    const archive = itemsArchive([
      { id: "x", type: "core.note", properties: {}, source: "s" },
    ]);
    const edited = editLineFile(
      archive,
      "edges",
      (text) => `${text}{"edge":{}}\n`,
    );
    expect(listEntries(edited).map((e) => e.name)).toEqual(
      listEntries(archive).map((e) => e.name),
    );
    expect(readLineFile(edited, "edges")).toBe('{"edge":{}}\n');
    expect(readLineFile(edited, "items")).toBe(readLineFile(archive, "items"));
  });
});

describe("itemsArchive", () => {
  it("opens with its manifest and line files, and pads a blob of any size", () => {
    const data = new Uint8Array(randomBytes(512 * 3 + 1));
    const archive = itemsArchive(
      [{ id: "x", type: "core.note", properties: {}, source: "s" }],
      [{ data, mime_type: "application/octet-stream" }],
    );
    expect(listEntries(archive).map((e) => e.name)).toEqual([
      "manifest.json",
      "instance.ndjson.gz",
      "items.ndjson.gz",
      "edges.ndjson.gz",
      `blobs/${blobHash(data)}`,
    ]);
    expect(archiveLines(archive, "items")).toHaveLength(1);
    const manifest = archiveManifest<{
      blob_count: number;
      blobs: Record<string, { size_bytes: number }>;
    }>(archive);
    expect(manifest.blob_count).toBe(1);
    expect(manifest.blobs[blobHash(data)]?.size_bytes).toBe(data.length);
  });

  it("names an entry as asked, whether or not the bytes hash to it", () => {
    const data = new Uint8Array([1, 2, 3]);
    const named = "sha256:" + "0".repeat(64);
    const archive = itemsArchive(
      [],
      [{ data, mime_type: "application/octet-stream", named }],
    );
    expect(
      Object.keys(archiveManifest<{ blobs: object }>(archive).blobs),
    ).toEqual([named]);
    expect(readEntry(archive, `blobs/${named}`)).not.toBeNull();
    expect(readEntry(archive, `blobs/${blobHash(data)}`)).toBeNull();
  });
});
