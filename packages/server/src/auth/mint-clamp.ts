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
 *
 * **The metadata wildcard takes the bare form, and this is not cosmetic.**
 * `metadata.*:write` does not match the sub-resource matcher — that class
 * carries no asterisk — so it falls through to the type matcher, clears
 * `isValidTypePattern` because `metadata` is a valid root, and parses as an
 * item-type grant over a namespace while reading as a metadata grant.
 * `scopes.ts` documents that hazard at the regex itself. Sending it through
 * the clamp fails in both directions at once: a plain `content:write` grant
 * covers it, so an app with no metadata scope at all mints a key holding
 * `metadata.types:write`; and a genuine `metadata:write` grant does not cover
 * it, so the honest holder is refused and told to obtain a literal that is not
 * in the family it is asking about. `"*"` is the ordinary key here, because it
 * is what `scopesToMetadataPermissions` writes for a bare `metadata:<verb>`
 * grant, so this is the common path rather than an edge case.
 */
export function scopeForEntry(
  family: "type" | "edge" | "metadata",
  key: string,
  level: string,
): string | null {
  if (level === "none") return null;
  if (family === "type") return `${key}:${level}`;
  if (family === "edge") return `edge.${key}:${level}`;
  return key === "*" ? `metadata:${level}` : `metadata.${key}:${level}`;
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
 * `extension_permissions` is not checked here because it cannot be: no scope
 * expresses one, so there is no literal to compare and nothing a grant could
 * be said to cover. **That makes it un-clampable rather than harmless**, which
 * is the opposite conclusion, and the route refuses the family outright for a
 * session rather than letting an unchecked map through — see
 * `refuseUnclampableExtensions`.
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

/**
 * Refuse an extension map from a session, because nothing can measure one.
 *
 * The clamp works by turning each requested entry into a scope literal and
 * asking whether the grant covers it. Extensions have no literal, so the only
 * honest answers are "refuse" and "let it through unchecked" — and unchecked
 * is real reach: `GET /items/{id}/extensions/{ns}` consults the extension map
 * alone, with no type-permission check beside it, so `{"*":"read"}` reads
 * every non-reserved namespace on every item in the space from a grant that
 * conferred nothing.
 *
 * An empty object is accepted, because it asks for nothing.
 */
export function refuseUnclampableExtensions(
  requested: RequestedReach,
): string | null {
  const map = requested.extension_permissions;
  if (map === undefined || Object.keys(map).length === 0) return null;
  return (
    "A signed-in app cannot ask for `extension_permissions`: no scope names " +
    "an extension namespace, so there is nothing to check the request against."
  );
}
