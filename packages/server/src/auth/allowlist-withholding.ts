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
 * **`space.*` is withheld from a bundle, and only from a bundle.** The
 * eleven administrative literals are now emitted by `buildAllowedScopes`
 * itself, from the closed set, so the family is requestable and the drop here
 * no longer decides that. What it decides is that a *bundle* can never be the
 * reason one is publishable, and that is the half worth keeping: a
 * bundle-claimed space permission leaves the consent screen's unclaimed-scope
 * bucket and would inherit the bundle's `default_on` tick, which is grant by
 * silence — the thing the family exists to stop.
 *
 * **The drop is therefore no longer visible in the allowlist's output**, since
 * the literal is emitted either way. It still shows at the other door, which
 * is the one that mattered more all along: `bundlePublishedScopes` is what a
 * stale client ceiling is *widened by*, and a literal admitted there is
 * written into a registration row that outlives the configuration that
 * introduced it. The allowlist is re-derived at every boot; a row is not.
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
import { isSpacePermission, type PermissionBundle } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";

/**
 * Whether this server refuses to publish a literal *because a bundle named
 * it*, even though the grammar recognizes it.
 *
 * Not "is this publishable at all": every space permission is, from the
 * closed set, emitted by the allowlist directly. This answers the narrower
 * question the bundle doors ask, which is whether a configuration may be the
 * thing that publishes it.
 *
 * Delegates to `isSpacePermission` rather than matching the root, so there is
 * one answer to "is this a space permission" rather than two that can drift.
 * It is exact membership of the closed set, which also gives the property
 * that matters here: a literal added to `SPACE_PERMISSIONS` is withheld by
 * having been added, rather than by somebody remembering this file.
 *
 * A malformed literal under the root is not this function's problem — it never
 * reaches here, because `isValidScope` refuses it one step earlier.
 */
export function isWithheldFromAllowlist(scope: string): boolean {
  return isSpacePermission(scope);
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
