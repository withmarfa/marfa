/**
 * Which body-size cap a path is held to.
 *
 * The blob doors and the archive restore stream their bodies to disk as they
 * arrive, so a body's size costs disk rather than memory, and a file, or an
 * archive of files, is as large as it is: they take no cap. The bulk write
 * doors carry up to 5000 rows in one body,
 * so they take the larger bulk cap; the per-request cap would refuse a
 * legitimate batch, and the doors still bound the row count and the per-field
 * sizes themselves.
 *
 * The one statement of it: `app.ts` mounts the guard from it and the
 * document declares `413` from it, so the two cannot disagree about a door.
 * The path may be spelled either way, `/blobs/:hash` or `/blobs/{hash}`.
 */
export type BodyCap = "none" | "bulk" | "request";

export function bodyCapFor(path: string): BodyCap {
  if (path.startsWith("/blobs") || path === "/admin/restore-archive") {
    return "none";
  }
  if (path.startsWith("/items/bulk") || path.startsWith("/edges/bulk")) {
    return "bulk";
  }
  return "request";
}
