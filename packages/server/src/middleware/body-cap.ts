/**
 * Blob and archive doors stream to disk, so they take no cap; bulk doors
 * need the larger one — stated once so `app.ts` and the OpenAPI doc agree.
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
