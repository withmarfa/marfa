import { makeSignature } from "better-auth/crypto";
import { grantCoversScope, parseScope } from "@withmarfa/shared";

/**
 * Order a parameter set the way the OAuth Provider plugin orders it before
 * signing, so a signature computed here matches one computed there.
 *
 * The plugin canonicalizes because anything between it and the browser, a CDN
 * or a proxy, is free to reorder query parameters in transit, and a signature
 * taken over the arrival order breaks whenever one does. Sort is by key, then
 * by value, so the parameters the plugin repeats still land in a stable
 * sequence.
 */
export function canonicalizeOAuthQueryParams(
  params: URLSearchParams,
): URLSearchParams {
  const canonical = new URLSearchParams();
  const entries = [...params.entries()].sort(
    ([keyA, valueA], [keyB, valueB]) => {
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      if (valueA < valueB) return -1;
      if (valueA > valueB) return 1;
      return 0;
    },
  );
  for (const [key, value] of entries) canonical.append(key, value);
  return canonical;
}

/**
 * The request the provider is asked to approve when the person chose types
 * under an all-data scope the request named.
 *
 * The provider approves only scopes written in the request it signed, by
 * exact match, and a type under `*:read` is not written there. So the query
 * is signed again with the same secret, naming the chosen scopes, and the
 * provider still checks the signature and that what is approved was named.
 *
 * `signedQuery` MUST already have passed the signature check: nothing here
 * verifies it. What this function guarantees is that the new query is never
 * wider than the old one. Every scope in `scopes` is either a literal the old
 * query named, or a read or write of an item type in `types` that an
 * all-data scope the old query named covers (`*:read` covers no write, and
 * nothing covers a permission). Otherwise it answers `null` and signs
 * nothing. Every parameter but `scope` is copied as it was, including `exp`,
 * so the window the provider signed does not move.
 *
 * Answers the query unchanged when `scopes` adds nothing to what it named.
 */
export async function narrowSignedQuery(
  signedQuery: string,
  scopes: readonly string[],
  types: readonly string[],
  secret: string,
): Promise<string | null> {
  const params = new URLSearchParams(signedQuery);
  if (params.getAll("sig").length !== 1) return null;
  const named = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const wide = named.filter((literal) => {
    const parsed = parseScope(literal);
    return parsed?.kind === "type" && parsed.typePattern === "*";
  });
  for (const literal of scopes) {
    if (named.includes(literal)) continue;
    const parsed = parseScope(literal);
    const covered =
      parsed?.kind === "type" &&
      parsed.typePattern !== "*" &&
      !parsed.typePattern.endsWith(".*") &&
      (parsed.operation === "read" || parsed.operation === "write") &&
      types.includes(parsed.typePattern) &&
      wide.some((all) => grantCoversScope([all], literal));
    if (!covered) return null;
  }
  if (scopes.every((literal) => named.includes(literal))) return signedQuery;
  params.delete("sig");
  params.set("scope", scopes.join(" "));
  params.set(
    "sig",
    await makeSignature(
      canonicalizeOAuthQueryParams(params).toString(),
      secret,
    ),
  );
  return params.toString();
}
