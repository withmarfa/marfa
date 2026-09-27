/**
 * How deep a path relative to a folder's root reaches: 0 for the root itself,
 * or null for a path that is absolute, drive-absolute, carries a backslash or
 * NUL, or climbs out of the folder at any point.
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
    if (segment === "" || segment === ".") continue;
    depth += segment === ".." ? -1 : 1;
    if (depth < 0) return null;
  }
  return depth;
}
