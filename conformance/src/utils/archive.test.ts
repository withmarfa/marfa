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
import { gunzipSync, gzipSync } from "node:zlib";
import { readTarGzEntry, tarGz } from "./archive.js";

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
