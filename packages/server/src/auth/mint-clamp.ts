/**
 * Clamping an OAuth-minted key to the reach the session itself holds.
 *
 * `POST /keys` used to refuse an OAuth caller outright, and that refusal was
 * the enforcement: a session could not mint, so it could not mint something
 * wider than itself. Replacing it with `capability.keys` removes the refusal
 * and leaves the escalation, so the clamp is what takes its place. Without it
 * an app granted `core.note:read` plus the capability could mint a
 * `space_admin` key that bypasses the permission maps entirely — a durable
 * credential wider than the grant it came from, and one that outlives it.
 *
 * **Every comparison goes through `grantCoversScope`.** It is the platform's
 * own answer to "does this grant reach that", it understands wildcards,
 * subtree patterns and verb ranking, and `scopes.ts` records five earlier
 * hand-rolled comparisons that disagreed with the real rule. A sixth is
 * recorded in the Raycast extension's own notes. There is no version of this
 * that is safe to write by hand.
 */
import {
  grantCoversScope,
  type EdgePermission,
  type ExtensionPermission,
  type MetadataPermission,
  type TypePermission,
} from "@withmarfa/shared";

/** The permission maps a mint may ask for, in the shape the request carries. */
export interface RequestedReach {
  type_permissions?: Record<string, TypePermission>;
  edge_permissions?: Record<string, EdgePermission>;
  metadata_permissions?: Record<string, MetadataPermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
}

/**
 * The scope literal a permission-map entry is asking for.
 *
 * `none` is not a request for anything, so it names no literal and is skipped
 * rather than compared: a map entry explicitly granting nothing cannot exceed
 * a grant, and asking `grantCoversScope` about a verb-less literal would send
 * a value the parser refuses into a function whose answer would then be "no"
 * for a reason that has nothing to do with breadth.
 */
export function scopeForEntry(
  family: "type" | "edge" | "metadata",
  key: string,
  level: string,
): string | null {
  if (level === "none") return null;
  if (family === "type") return `${key}:${level}`;
  if (family === "edge") return `edge.${key}:${level}`;
  return `metadata.${key}:${level}`;
}

/**
 * The first literal the grant does not cover, or null when it covers all of
 * them.
 *
 * Answers with the literal rather than a boolean because the refusal has to
 * name it: a client told only that it asked for too much cannot narrow toward
 * anything, and the whole point of replacing the blanket 403 was to stop
 * sending people to a reason that was not theirs.
 *
 * `extension_permissions` is deliberately not checked, because no scope
 * expresses one — the grammar has no extension family, so there is no literal
 * to compare and nothing a grant could be said to cover. The mint derives it
 * as `{}` instead, which is what the synthetic key carries, so an OAuth mint
 * cannot ask for an extension grant at all.
 */
export function firstUncoveredScope(
  granted: readonly string[],
  requested: RequestedReach,
): string | null {
  const families = [
    ["type", requested.type_permissions],
    ["edge", requested.edge_permissions],
    ["metadata", requested.metadata_permissions],
  ] as const;
  for (const [family, map] of families) {
    for (const [key, level] of Object.entries(map ?? {})) {
      const scope = scopeForEntry(family, key, level);
      if (scope === null) continue;
      if (!grantCoversScope(granted, scope)) return scope;
    }
  }
  return null;
}
