/**
 * Clamping a minted key to the reach its creator itself holds.
 *
 * `POST /keys` used to refuse an OAuth caller outright, and that refusal was
 * the enforcement: a session could not mint, so it could not mint something
 * wider than itself. Replacing it with `keys.mint` removes the refusal
 * and leaves the escalation, so the clamp is what takes its place. Without it
 * an app granted `core.note:read` plus the permission could mint a key whose
 * own maps reach every type — a durable credential wider than the grant it
 * came from, and one that outlives it.
 *
 * **The same is true of a key minted by a key, and that half is newer.** While
 * a role admitted a credential past its own maps, every caller that could
 * reach this route already reached everything, so "wider than its creator" had
 * nothing to bite on. Under one permission model a narrow credential is an
 * ordinary thing: a key holding `keys.mint` and read on one type is a
 * coherent credential, and nothing about holding the permission to mint says
 * anything about how far what it mints may reach. So the ceiling is asked of
 * every creator, and `firstReachBeyondCredential` is what lets a key's own
 * maps be compared by a rule of the same standing a grant gets.
 *
 * **Two carriers, two comparisons, and one of them is not the other.** A
 * session holds a list of scope literals, so the question is whether the grant
 * covers each thing asked for, and `grantCoversScope` is the platform's own
 * answer to it. A key holds permission maps, where an exact entry outranks
 * every wildcard, so a map can deny a row rather than merely omit it — and a
 * list cannot express that. Measuring a map by first reducing it to the
 * literals it confers loses exactly the denials, which is the escalation
 * `firstReachBeyondCredential` exists to close.
 *
 * **Neither comparison is written by hand.** `scopes.ts` records five earlier
 * hand-rolled comparisons that disagreed with the real rule, and a sixth is
 * recorded in the Raycast extension's own notes. Both of the two here are
 * that file's own functions, over the same resolvers the request path runs.
 */
import {
  firstReachBeyondMap,
  grantCoversScope,
  GLOBAL_TYPE_WILDCARD,
  typeMatchesPattern,
  type EdgePermission,
  type ExtensionPermission,
  type MetadataPermission,
  type ProfilePermission,
  type TypePermission,
} from "@withmarfa/shared";

/** The permission maps a mint may ask for, in the shape the request carries. */
export interface RequestedReach {
  type_permissions?: Record<string, TypePermission>;
  edge_permissions?: Record<string, EdgePermission>;
  metadata_permissions?: Record<string, MetadataPermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  profile_permissions?: Record<string, ProfilePermission>;
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
  family: "type" | "edge" | "metadata" | "profile",
  key: string,
  level: string,
): string | null {
  if (level === "none") return null;
  if (family === "type") return `${key}:${level}`;
  if (family === "edge") return `edge.${key}:${level}`;
  if (family === "profile") {
    return key === "*" ? `profile:${level}` : `profile.${key}:${level}`;
  }
  return key === "*" ? `metadata:${level}` : `metadata.${key}:${level}`;
}

/**
 * The first reach the request asks for that the credential does not itself
 * hold, or null when the credential covers all of it.
 *
 * **Projecting a credential's maps into scope literals and reusing
 * `grantCoversScope` was the obvious way to write this, and it is unsound.**
 * A map entry at `none` names no literal, so the projection drops it — and on
 * the requesting side that is correct, because asking for nothing cannot
 * exceed anything. On the *holding* side it is a hole. An exact entry outranks
 * every wildcard, so `{"*":"read","system.credential":"none"}` denies that row
 * rather than omitting it, and that map is what an ordinary `content:read`
 * grant projects to. Reduced to `["*:read"]` the denials are gone, and a child
 * asking for `{"*":"read"}` — which reads as a no-op — resolves `read` on rows
 * its parent was refused.
 *
 * A second failure came free with the same projection: a `type_permissions`
 * key of `metadata` produced the literal `metadata:write`, which parses into
 * the metadata family, so a type entry conferred a metadata grant.
 *
 * `firstReachBeyondMap` compares the two maps by what they resolve to rather
 * than by what either lists, per axis, so neither can happen. Extensions are
 * not an axis there — no literal names a namespace — and stay a direct map
 * comparison in `firstUncoveredExtension`.
 */
export function firstReachBeyondCredential(
  held: RequestedReach,
  requested: RequestedReach,
): string | null {
  const axes = [
    ["type", held.type_permissions, requested.type_permissions],
    ["edge", held.edge_permissions, requested.edge_permissions],
    ["metadata", held.metadata_permissions, requested.metadata_permissions],
    ["profile", held.profile_permissions, requested.profile_permissions],
  ] as const;
  for (const [axis, heldMap, requestedMap] of axes) {
    const key = firstReachBeyondMap(axis, heldMap, requestedMap);
    if (key === null) continue;
    // The witness may be a key only the held map named, in which case the
    // level to report is what the request resolves there — which is the reach
    // being refused, and is never `none` or the witness would not have been
    // returned.
    const level = resolveRequestedLevel(axis, requestedMap, key);
    return scopeForEntry(axis, key, level) ?? `${key}:${level}`;
  }
  return null;
}

/** What the requested map gives at one key, for the refusal message alone. */
function resolveRequestedLevel(
  axis: "type" | "edge" | "metadata" | "profile",
  requested: Record<string, string> | undefined,
  key: string,
): string {
  const map = requested ?? {};
  const exact = map[key];
  if (exact !== undefined && exact !== "none") return exact;
  // Reached through a wildcard rather than named. `write` is the honest
  // ceiling to report: it is the most the wildcard could have conferred, and
  // the message is about breadth rather than about an exact level.
  const wildcard = map[GLOBAL_TYPE_WILDCARD];
  if (wildcard !== undefined && wildcard !== "none") return wildcard;
  if (axis === "type") {
    for (const [pattern, level] of Object.entries(map)) {
      if (level === "none") continue;
      if (typeMatchesPattern(key, pattern)) return level;
    }
  }
  return "write";
}

/**
 * The first extension namespace the creator does not hold at the level asked
 * for, or null when it holds them all.
 *
 * **A key's creator can be asked this and a session cannot**, which is why the
 * family is refused outright for a session and compared directly here. A grant
 * carries no literal for an extension namespace, so there is nothing to
 * compare it against; a key carries a map of exactly the same shape as the one
 * being requested, so the comparison is a lookup.
 *
 * `write` covers `read`, matching every other family. A namespace absent from
 * the creator's map is not held at any level.
 */
export function firstUncoveredExtension(
  held: Record<string, ExtensionPermission> | undefined,
  requested: Record<string, ExtensionPermission> | undefined,
): string | null {
  for (const [namespace, level] of Object.entries(requested ?? {})) {
    const mine = held?.[namespace] ?? held?.["*"];
    if (mine === undefined) return namespace;
    if (level === "write" && mine !== "write") return namespace;
  }
  return null;
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
    // Profile is measurable against a grant — `profile:<verb>` and
    // `profile.<row>:<verb>` are real literals — and was not being measured.
    ["profile", requested.profile_permissions],
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
 * every namespace on every item in the space from a grant that conferred
 * nothing. Every namespace, reserved ones included: `RESERVED_NAMESPACES` is
 * consulted on the write and delete doors and on neither read door.
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
