/**
 * The tar reader, against inputs its one call site does not reach.
 *
 * `instance.test.ts` asks it for `manifest.json`, which the server writes
 * first, so the walk that skips a member by its size, the answer for a name
 * the archive does not carry, and the refusal of a size field it cannot read
 * are all exercised nowhere else. A reader that answered `null` for a member
 * that is present would make an assertion about the manifest pass by
 * default, which is the shape of defect this suite keeps finding.
 *
 * A util rather than a suite file, so it may import from the workspace — but
 * it needs nothing beyond the writer in the module it tests.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  blobHash,
  itemsArchive,
  listTarGzEntries,
  readTarGzEntry,
  tarGz,
} from "./archive.js";

/** The same archive with the first entry's size field written differently. */
function rewriteFirstSize(archive: Uint8Array, field: string): Uint8Array {
  const tar = Buffer.from(gunzipSync(Buffer.from(archive)));
  tar.fill(0, 124, 136);
  tar.write(field, 124, 12, "binary");
  return new Uint8Array(gzipSync(tar));
}

const three = [
  { name: "manifest.json", body: '{"version":2}' },
  // Exactly one block, so the next header sits at the boundary rather than
  // after padding: an off-by-one in the skip lands mid-header either way,
  // and this is the case where the padding cannot hide it.
  { name: "items.ndjson", body: "x".repeat(512) },
  { name: "edges.ndjson", body: "" },
];

describe("readTarGzEntry", () => {
  it("reads the first member", () => {
    expect(readTarGzEntry(tarGz(three), "manifest.json")).toBe('{"version":2}');
  });

  it("skips past earlier members to reach a later one", () => {
    expect(readTarGzEntry(tarGz(three), "items.ndjson")).toBe("x".repeat(512));
  });

  it("reads a member the writer emitted empty", () => {
    // Emitted rather than omitted, which is how a damaged archive is told
    // from an empty one — so "" and null have to be different answers.
    expect(readTarGzEntry(tarGz(three), "edges.ndjson")).toBe("");
  });

  it("answers null for a name the archive does not carry", () => {
    expect(readTarGzEntry(tarGz(three), "types.ndjson")).toBeNull();
  });

  it("reads a size field written in the left-padded spelling", () => {
    // `          15` is a legal USTAR size and is what a reader that cut the
    // field at its first space would see as empty. `parseInt("", 8)` is
    // `NaN`, the walk leaves the archive, and the answer is "no such member"
    // — indistinguishable from an export that stopped writing one. The
    // writer in this module does not produce this spelling; other tars do.
    const tar = rewriteFirstSize(tarGz(three), "          15");
    expect(readTarGzEntry(tar, "manifest.json")).toBe('{"version":2}');
  });

  it("refuses a size it cannot read rather than reporting the member absent", () => {
    // Base-256, which tar writes for a member of 8 GiB or more and this
    // reader does not read. Answering `null` would say the member is not
    // there; the throw says the reader cannot tell.
    const tar = rewriteFirstSize(tarGz(three), "\u0080\u0000\u0000\u0000");
    expect(() => readTarGzEntry(tar, "manifest.json")).toThrow(
      /unreadable size/,
    );
  });
});

describe("listTarGzEntries", () => {
  it("lists every member in the order the archive carries them", () => {
    expect(listTarGzEntries(tarGz(three)).map((e) => e.name)).toEqual([
      "manifest.json",
      "items.ndjson",
      "edges.ndjson",
    ]);
  });

  it("reads each member's body, including one that fills a block and one that is empty", () => {
    expect(
      listTarGzEntries(tarGz(three)).map((e) => e.body.toString("utf8")),
    ).toEqual(['{"version":2}', "x".repeat(512), ""]);
  });
});

describe("itemsArchive", () => {
  it("pads a blob entry of any size, so the members after it are still found", () => {
    // One byte past a block boundary: the shape a padding mistake would
    // put the reader off, with a member after it to be found.
    const data = new Uint8Array(randomBytes(512 * 3 + 1));
    const archive = itemsArchive(
      [{ id: "x", type: "core.note", properties: {}, source: "s" }],
      [{ data, mime_type: "application/octet-stream" }],
    );
    expect(readTarGzEntry(archive, "types.ndjson")).toBe("");
    expect(readTarGzEntry(archive, "edges.ndjson")).toBe("");
    const manifest = JSON.parse(
      readTarGzEntry(archive, "manifest.json") ?? "{}",
    ) as { blob_count: number; blobs: Record<string, { size_bytes: number }> };
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
    const manifest = JSON.parse(
      readTarGzEntry(archive, "manifest.json") ?? "{}",
    ) as { blobs: Record<string, unknown> };
    expect(Object.keys(manifest.blobs)).toEqual([named]);
    expect(readTarGzEntry(archive, `blobs/${named}`)).not.toBeNull();
    expect(readTarGzEntry(archive, `blobs/${blobHash(data)}`)).toBeNull();
  });
});
