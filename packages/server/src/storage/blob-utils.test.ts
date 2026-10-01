import { describe, it, expect } from "vitest";
import { collectBlobHashes } from "./blob-utils.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"0123456789abcdef".repeat(4)}`;

function collect(value: unknown): string[] {
  const out = new Set<string>();
  collectBlobHashes(value, out);
  return [...out].sort();
}

describe("collectBlobHashes", () => {
  it("takes a property whose whole value is a hash", () => {
    expect(collect({ blob_ref: A })).toEqual([A]);
  });

  it("takes every hash linked inside a string, a Markdown body included", () => {
    const body = `An image ![chart](${A}) and a file [notes](/blobs/${B}).`;
    expect(collect({ body })).toEqual([A, B].sort());
  });

  it("walks nested objects and arrays", () => {
    expect(
      collect({ blocks: [{ text: `see ${A}` }, { children: [B] }] }),
    ).toEqual([A, B].sort());
  });

  it("takes no run of hex longer or shorter than a hash, and no other word ending in sha256", () => {
    expect(
      collect({
        longer: `${A}0`,
        longerUpper: `${A}F`,
        shorter: A.slice(0, -1),
        upper: A.toUpperCase(),
        prefixed: `xsha256:${"a".repeat(64)}`,
      }),
    ).toEqual([]);
  });

  it("takes a hash however the text around it ends", () => {
    expect(collect({ a: `${A}.`, b: `(${B})` })).toEqual([A, B].sort());
  });
});
