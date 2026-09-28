/**
 * Blob and archive doors stream to disk, so they take no cap; bulk doors
 * (rows or agreements) need the larger one — stated once so `app.ts`'s mount and the OpenAPI doc can't disagree.
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
