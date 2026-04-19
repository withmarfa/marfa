import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Timing-safe equality for strings. Equalises the two buffers to the
 * length of the longer input before comparing so `timingSafeEqual`'s
 * length precondition cannot itself leak information about the
 * expected length. Returns false when lengths differ.
 *
 * Use for any comparison where one side is a secret or a value
 * derived from a secret: OAuth PKCE code challenge, webhook HMAC
 * signatures, session tokens, etc. Do NOT use plain `===` for those.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // Equalise lengths so timingSafeEqual doesn't throw on mismatch.
  // We use a digest of each side so the padded buffers carry no
  // residual information about the original inputs.
  const maxLen = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  const lengthsEqual = aBuf.length === bBuf.length;
  return timingSafeEqual(aPadded, bPadded) && lengthsEqual;
}

/** SHA256 digest as hex. Convenience wrapper around node:crypto. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
