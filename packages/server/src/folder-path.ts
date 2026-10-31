/**
 * How deep a path relative to a folder's root reaches: 0 for the root itself,
 * or null for a path that is absolute, drive-absolute, carries a backslash or
 * NUL, or holds a `..` name. A device treats a path with `..` as outside the
 * folder wherever it climbs back, so no setting may hold one.
 */
export function depthInsideFolder(path: string): number | null {
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return null;
  }
  let depth = 0;
  for (const segment of path.split("/")) {
    if (segment === "..") return null;
    if (segment === "" || segment === ".") continue;
    depth += 1;
  }
  return depth;
}
