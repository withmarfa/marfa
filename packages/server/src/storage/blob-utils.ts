/**
 * A blob's digest wherever it sits in a string: a whole value, a `sha256:`
 * link inside text, an escaped or URL-encoded one, or the bare hex the blob
 * door also serves. Any run of exactly 64 lowercase hex characters counts,
 * whatever else is beside it, because a run read wrongly as a hash only
 * keeps bytes longer, while a hash missed deletes bytes something still
 * shows. A run straight after `%3a` counts too: that escape ends in a hex
 * letter, and an encoder may write it lowercase.
 */
const BLOB_DIGEST_IN_TEXT =
  /(?:(?<=%3a)|(?<![0-9a-f]))[0-9a-f]{64}(?![0-9a-f])/g;

/**
 * Recursively scan a value tree for blob hashes (`sha256:...`).
 * Custom types can store blob hashes in any field, and any text can link
 * one — this traverses objects, arrays, and strings to find them all.
 */
export function collectBlobHashes(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.length < 64) return;
    for (const match of value.matchAll(BLOB_DIGEST_IN_TEXT)) {
      out.add(`sha256:${match[0]}`);
    }
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
