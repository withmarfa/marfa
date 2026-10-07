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

  it("takes a hash whatever letter, digit or escape sits beside it", () => {
    const hexA = A.slice("sha256:".length);
    const hexB = B.slice("sha256:".length);
    expect(collect({ escaped: `line one\\n${A}` })).toEqual([A]);
    expect(collect({ digit: `1${A}` })).toEqual([A]);
    expect(collect({ upper: `${A}Fig` })).toEqual([A]);
    expect(collect({ word: `x${A}` })).toEqual([A]);
    expect(collect({ encoded: `/blobs/sha256%3A${hexB}` })).toEqual([B]);
    expect(collect({ lower: `/blobs/sha256%3a${hexB}` })).toEqual([B]);
    expect(collect({ bare: `![chart](/blobs/${hexA})` })).toEqual([A]);
    expect(collect({ whole: hexB })).toEqual([B]);
  });

  it("takes no run of lowercase hex longer or shorter than a hash", () => {
    const hex = "a".repeat(64);
    expect(
      collect({
        longer: `${hex}0`,
        longerBefore: `0${hex}`,
        prefixedLonger: `sha256:${hex}b`,
        shorter: hex.slice(1),
        upper: hex.toUpperCase(),
      }),
    ).toEqual([]);
  });

  it("takes a hash however the text around it ends", () => {
    expect(collect({ a: `${A}.`, b: `(${B})` })).toEqual([A, B].sort());
  });
});
