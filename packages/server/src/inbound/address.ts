import { createHash, randomBytes } from "node:crypto";

/** Where every inbound webhook address lives. */
export const INBOUND_PREFIX = "/inbound/";

/** Thirty-two random bytes: the token alone is what makes an address
 *  unguessable. */
export function mintInboundToken(): string {
  return randomBytes(32).toString("base64url");
}

/** An unkeyed digest is enough for a token of this entropy, and it keeps
 *  every address valid across a rotation of the instance secret. */
export function hashInboundToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Whatever the case: a sender misconfigured to `/Inbound/` still sent the token.
const ADDRESS = /\/inbound\/([^?#\s]*)/gi;
const ADDRESS_AT = /\/inbound\//i;

/**
 * A path or URL as it may be written anywhere outside the database. An
 * inbound address is a credential, so everything after the prefix but its
 * last four characters goes.
 */
export function loggablePath(pathOrUrl: string): string {
  // The router decodes a path before it matches, so an address spelled with
  // escapes is still an address; it is written decoded, and redacted.
  let decoded = pathOrUrl;
  try {
    decoded = decodeURIComponent(pathOrUrl);
  } catch {
    // An escape that does not decode leaves the text as it came.
  }
  const text =
    decoded === pathOrUrl || !ADDRESS_AT.test(decoded) ? pathOrUrl : decoded;
  return text.replace(
    ADDRESS,
    (_, token: string) => `${INBOUND_PREFIX}****${token.slice(-4)}`,
  );
}
