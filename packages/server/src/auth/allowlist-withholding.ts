/**
 * What a configured permission bundle may not publish into the scope
 * allowlist, in one place because three doors ask.
 *
 * **The allowlist is assembled from registry keys and is well-formed by
 * construction. A bundle's scopes are configuration.** `MARFA_PERMISSION_BUNDLES`
 * parses arbitrary JSON and validates shape only — an id that is a string, a
 * scopes array, a boolean — so the bundle loop is the only way into the
 * allowlist that does not pass a parser. It filtered on `isValidScope` alone,
 * which answers whether the grammar recognizes a literal rather than whether
 * this server is willing to publish it.
 *
 * ## What is withheld, and what deliberately is not
 *
 * **`capability.*` is withheld.** The eleven administrative literals are a
 * closed set that `buildAllowedScopes` never emits, and the withholding was by
 * omission rather than by a check — nothing in the provider references
 * `CAPABILITY_SCOPES` at all. They are grammatically valid, they carry curated
 * consent copy, and they name authority over administrative surfaces rather
 * than over content, so a bundle naming one made it requestable, consentable
 * and grantable with no warning.
 *
 * **A scope over a type or edge type nothing has registered is NOT withheld,
 * and that is deliberate.** `acme.thing:read` parses, and the allowlist
 * enumerates only types the registry holds, so a bundle naming it publishes a
 * literal that resolves against nothing today. That is the same shape as a
 * grant made before a type was registered and is not an escalation: the
 * pattern reaches whatever the registry later calls `acme.thing`, which is
 * what a wildcard already does on purpose. Refusing it would also make a
 * bundle's validity depend on boot ordering, since the registry is seeded
 * after configuration is read.
 *
 * **The OIDC literals, the content category and Category 2 are not withheld**
 * because the allowlist emits all three itself. A bundle naming one adds
 * nothing it did not already hold.
 */
import { isCapabilityScope, type PermissionBundle } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";

/**
 * Whether this server refuses to publish a literal a bundle named, even
 * though the grammar recognizes it.
 *
 * Delegates to `isCapabilityScope` rather than matching the root, so there is
 * one answer to "is this a capability" rather than two that can drift. It is
 * exact membership of the closed set, which also gives the property that
 * matters here: a literal added to `CAPABILITY_SCOPES` is withheld by having
 * been added, rather than by somebody remembering this file.
 *
 * A malformed literal under the root is not this function's problem — it never
 * reaches here, because `isValidScope` refuses it one step earlier.
 */
export function isWithheldFromAllowlist(scope: string): boolean {
  return isCapabilityScope(scope);
}

/**
 * Literals already reported, so a permanently misconfigured bundle costs one
 * log line rather than one per call. Bounded by the configured bundles rather
 * than by request input.
 */
const reported = new Set<string>();

/** Warn once that a configured bundle named something this server withholds. */
export function warnOnceAboutWithheldBundleScope(scope: string): void {
  if (reported.has(scope)) return;
  reported.add(scope);
  log("warn", "permission bundle names a scope this server withholds", {
    scope,
    action: "dropped from the OAuth scope allowlist",
  });
}

/** Test seam: the warn-once set is process-level and would otherwise leak
 *  between cases in the same worker. */
export function resetWithheldScopeWarnings(): void {
  reported.clear();
}

/**
 * The scopes a bundle set publishes, with the withheld ones dropped and
 * reported. Both bundle doors call this rather than filtering for themselves,
 * because a drop applied at one and not the other is the shape of defect this
 * closes.
 */
export function publishableBundleScopes(
  bundles: readonly PermissionBundle[],
  isValid: (scope: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const bundle of bundles) {
    for (const scope of bundle.scopes) {
      if (!isValid(scope)) continue;
      if (isWithheldFromAllowlist(scope)) {
        warnOnceAboutWithheldBundleScope(scope);
        continue;
      }
      out.push(scope);
    }
  }
  return out;
}
