/**
 * Scope-set comparison shared by the two `OauthProviderStore` dialects.
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
