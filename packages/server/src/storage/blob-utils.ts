/**
 * A blob hash wherever it sits in a string: a whole value, or a link inside
 * text such as a Markdown body. The boundaries keep a longer hex run, or a
 * word that merely ends in `sha256`, from reading as a hash.
 */
const BLOB_HASH_IN_TEXT = /(?<![0-9A-Za-z])sha256:[0-9a-f]{64}(?![0-9A-Fa-f])/g;

/**
 * Recursively scan a value tree for blob hashes (`sha256:...`).
 * Custom types can store blob hashes in any field, and any text can link
 * one — this traverses objects, arrays, and strings to find them all.
 */
export function collectBlobHashes(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (!value.includes("sha256:")) return;
    for (const match of value.matchAll(BLOB_HASH_IN_TEXT)) out.add(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const el of value) collectBlobHashes(el, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectBlobHashes(v, out);
    }
  }
}
