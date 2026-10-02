import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey, SECRET_INFO } from "../crypto/derive-key.js";

/**
 * The link the instance serves for a blob no object store can sign a link
 * for: the bytes come from the instance, but the caller needs no credential,
 * so a browser, a phone or a media player can be handed the URL as it is.
 *
 * The signature is a MAC over the hash and the expiry, so a link cannot be
 * re-pointed at another blob or extended. It carries no caller identity:
 * whoever holds the link holds the bytes until it expires, which is the
 * same promise a presigned object-store link makes.
 */

/** Seven days, the ceiling SigV4 puts on a presigned link, so the two kinds
 *  of link obey one rule. */
export const MAX_BLOB_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

function signature(secret: string, hash: string, expiresAt: number): Buffer {
  return createHmac("sha256", deriveKey(secret, SECRET_INFO.blobLink))
    .update(`${hash}\n${String(expiresAt)}`)
    .digest();
}

/** Rounded up, or a link loses the rest of its minting second and can die
 *  unfetched; clamped, since a store's own link cannot outlive the cap. */
export function blobLinkExpiry(nowMs: number, ttlSeconds: number): number {
  return Math.min(
    Math.ceil(nowMs / 1000) + ttlSeconds,
    Math.floor(nowMs / 1000) + MAX_BLOB_LINK_TTL_SECONDS,
  );
}

/**
 * The link's URL. `secret` is the instance's `MARFA_AUTH_SECRET`; `origin`
 * is the scheme and host the instance is reached at; `expiresAt` is Unix
 * seconds.
 */
export function mintBlobLink(
  secret: string,
  origin: string,
  hash: string,
  expiresAt: number,
): string {
  const url = new URL(`/blobs/${hash}/fetch`, origin);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set(
    "signature",
    signature(secret, hash, expiresAt).toString("hex"),
  );
  return url.toString();
}

/**
 * Whether a link's query proves it was minted here for this hash and has
 * not expired. Compared in constant time; a malformed signature is a bad
 * signature, not an error.
 */
export function verifyBlobLink(
  secret: string,
  hash: string,
  expires: string,
  presented: string,
  nowSeconds: number,
): boolean {
  if (!/^\d{1,12}$/.test(expires)) return false;
  const expiresAt = Number(expires);
  if (expiresAt <= nowSeconds) return false;
  const expected = signature(secret, hash, expiresAt);
  // `Buffer.from(..., "hex")` stops at the first character that is not hex
  // rather than throwing, so a malformed value arrives short and fails the
  // length check.
  const given = Buffer.from(presented, "hex");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
