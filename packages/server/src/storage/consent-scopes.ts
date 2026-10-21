import {
  firstReachBeyondMap,
  parseScope,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  scopesToProfilePermissions,
} from "@withmarfa/shared";
import { containsProfileEmailWrite } from "../auth/profile-scope.js";

/** Compare effective reach: dropping a narrower map entry can widen its wildcard. */
export function scopesAreNarrower(
  held: readonly string[],
  wanted: readonly string[],
): boolean {
  if (
    containsProfileEmailWrite(wanted) ||
    wanted.some((scope) => parseScope(scope) === null)
  )
    return false;
  const maps = [
    ["type", scopesToTypePermissions],
    ["edge", scopesToEdgePermissions],
    ["metadata", scopesToMetadataPermissions],
    ["profile", scopesToProfilePermissions],
  ] as const;
  for (const [axis, project] of maps)
    if (firstReachBeyondMap(axis, project(held), project(wanted)) !== null)
      return false;
  return wanted.every((literal) => {
    const scope = parseScope(literal);
    return (
      (scope?.kind !== "permission" && scope?.kind !== "oidc") ||
      held.includes(literal)
    );
  });
}

/**
 * Scope-set comparison, held outside `OauthProviderStore` so the rule can
 * be read and tested without one.
 *
 * Consent scopes are an unordered set stored as an ordered list, and the
 * order a row comes back in depends on the order the writer happened to
 * pass. Comparing as sets keeps the guard in `setConsentScopes` about
 * what was granted rather than how it was serialized.
 */
export function sameScopeSet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const scope of left) {
    if (!right.has(scope)) return false;
  }
  return true;
}
