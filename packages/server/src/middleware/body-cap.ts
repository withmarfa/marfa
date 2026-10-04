/**
 * Blob and archive doors stream to disk, so they take no cap; bulk doors
 * need the larger one — stated once so `app.ts` and the OpenAPI doc agree.
 * Inbound caps after its endpoint lookup, so an unknown address reads nothing.
 */
export type BodyCap = "none" | "bulk" | "request" | "inbound";

export function bodyCapFor(path: string): BodyCap {
  if (path.startsWith("/blobs") || path === "/admin/restore-archive") {
    return "none";
  }
  if (path.startsWith("/inbound/")) return "inbound";
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
