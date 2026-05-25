import { isValidBlobHash } from "@withmarfa/shared";

/**
 * Recursively scan a value tree for blob hashes (`sha256:...`).
 * Custom types can store blob hashes in any field — this traverses
 * objects, arrays, and strings to find them all.
 */
export function collectBlobHashes(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (isValidBlobHash(value)) out.add(value);
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
