/**
 * Web Crypto helpers — internal to `@withmarfa/webhooks`.
 *
 * `globalThis.crypto.subtle` is available in Cloudflare Workers and
 * Node 20+, so a single implementation works in both runtimes without
 * a `node:crypto` import path.
 */

const subtle = globalThis.crypto.subtle;

/** HMAC-SHA256 of `body` keyed by `secret`. Returns the lowercase hex
 *  digest. */
export async function hmacSha256Hex(
  secret: string,
  body: ArrayBuffer | Uint8Array,
): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const key = await subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // Web Crypto's `sign` wants ArrayBuffer-shaped input. ArrayBuffer
  // pre-decoded inputs (from caller) take the fast path; Uint8Array
  // inputs (e.g. TextEncoder output) get sliced into a fresh
  // ArrayBuffer to satisfy the strict ArrayBuffer typing.
  const data: ArrayBuffer =
    body instanceof Uint8Array
      ? (body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer)
      : body;
  const sigBuf = await subtle.sign("HMAC", key, data);
  return bufferToHex(sigBuf);
}

export function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Both inputs MUST be the same length — callers length-check before calling. */
export function constantTimeEqualsString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Case-insensitive constant-time hex comparison. */
export function constantTimeEqualsHex(a: string, b: string): boolean {
  return constantTimeEqualsString(a.toLowerCase(), b.toLowerCase());
}
