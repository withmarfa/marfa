import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Timing-safe equality for strings. Compares SHA-256 digests of the two
 * inputs rather than the raw bytes: the digests are always 32 bytes, so
 * `timingSafeEqual`'s equal-length precondition holds with no padding, and
 * the comparison leaks nothing about either input's length (raw inputs of
 * different lengths still produce same-length digests). The final
 * `a === b`-length check preserves the "false on length mismatch" contract
 * cheaply — a digest collision across different-length inputs is
 * cryptographically infeasible, but the explicit check makes the contract
 * exact rather than probabilistic.
 *
 * Use for any comparison where one side is a secret or a value
 * derived from a secret: OAuth PKCE code challenge, webhook HMAC
 * signatures, session tokens, etc. Do NOT use plain `===` for those.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(aDigest, bDigest) && a.length === b.length;
}

/** SHA256 digest as hex. Convenience wrapper around node:crypto. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
