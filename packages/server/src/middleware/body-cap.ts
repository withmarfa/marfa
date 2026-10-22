/**
 * Blob and archive doors stream to disk, so they take no cap; bulk doors
 * need a larger one, and connector state and registration their own. Stated
 * once so `app.ts` and the OpenAPI doc agree.
 * Inbound caps after its endpoint lookup, so an unknown address reads nothing.
 * The picture doors take raw image bytes, not JSON, and count them as they
 * arrive (`routes/picture.ts`), so the general limiter and the JSON guard
 * leave them alone.
 */
export type BodyCap =
  | "none"
  | "bulk"
  | "request"
  | "inbound"
  | "connector-state"
  | "registration"
  | "picture";

export function bodyCapFor(path: string): BodyCap {
  if (path.startsWith("/blobs") || path === "/restore") {
    return "none";
  }
  if (path === "/auth/oauth2/register") return "registration";
  if (/^\/connectors\/[^/]+\/state$/.test(path)) return "connector-state";
  if (path.startsWith("/inbound/")) return "inbound";
  if (path === "/owner/picture" || path === "/profile/picture")
    return "picture";
  if (
    path.startsWith("/items/bulk") ||
    path.startsWith("/edges/bulk") ||
    /^\/connectors\/[^/]+\/agreements$/.test(path)
  ) {
    return "bulk";
  }
  return "request";
}

/**
 * The largest body a bulk door takes, `MARFA_MAX_BULK_REQUEST_BYTES`, which
 * is the largest any door that writes an item's or an edge's properties
 * takes, so no row a write door accepts has properties larger than this.
 */
export function bulkBodyCap(config: { maxBulkRequestBytes?: number }): number {
  return config.maxBulkRequestBytes ?? 16 * 1024 * 1024;
}

/** Two independently bounded documents plus the process's worst JSON encoding. */
export const CONNECTOR_STATE_BODY_CAP =
  2 * 512 * 1024 +
  100 * 6 +
  Buffer.byteLength(JSON.stringify({ process: "", state: {}, problems: {} })) -
  4;

/**
 * The largest registration Marfa reads. Registration takes no credential and
 * answers every origin, and what it stores lives until the reaper takes it,
 * so a page could otherwise park the general cap's worth per request. The
 * first-party clients register in about 200 bytes and a hosted assistant's
 * dynamic registration in under a kilobyte; 32 KiB leaves room for a signed
 * software statement and still bounds what one request can leave behind.
 */
export const REGISTRATION_BODY_CAP = 32 * 1024;

/**
 * The most redirect URIs one registration may name. Marfa's own clients name
 * none (they use the device grant) and a web page or hosted assistant names
 * one or two; the consent screen names every origin they span.
 */
export const MAX_REGISTERED_REDIRECT_URIS = 10;
