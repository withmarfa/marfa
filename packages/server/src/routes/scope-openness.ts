/**
 * Whether a grant reaches things that do not exist yet, and the two sentences
 * that say so.
 *
 * One derivation and two strings, in one module, because the property has to
 * be stated on two surfaces that render nothing alike. The authorize screen
 * puts it on a toggle row's second line; the device screen has no rows and
 * prints a flat list of sentences. Kept out of both renderers so neither can
 * grow a second answer to a question the grammar already settles, and kept
 * out of the copy maps entirely so that no curated string can state it.
 *
 * **A curated string is exactly how this failed before.** A wildcard
 * description written for the device screen carried its own futurity clause,
 * and the authorize screen's label falls through to the description when
 * nothing curated names the pattern, so that same sentence arrived as a
 * toggle label with the row about to say the same thing beneath it. The
 * reconciliation was a regex over the copy, which could not tell a clause
 * that means futurity from a word that merely spells it, and got both
 * readings wrong in opposite directions. Composing the sentence here instead
 * means neither surface has to read English to know whether it has already
 * been said.
 */

import type { ParsedScope } from "@withmarfa/shared";
import {
  GLOBAL_TYPE_WILDCARD,
  scopesToMetadataPermissions,
  subtreeWildcardRoot,
} from "@withmarfa/shared";

/**
 * Whether a scope reaches things that do not exist yet.
 *
 * Two shapes qualify and they share nothing in the grammar, so both are
 * asked rather than inferred from the spelling. A subtree wildcard covers
 * its root and everything under it, later registrations included. The bare
 * `metadata` root carries no wildcard character at all and is the one that
 * reads as concrete: it projects to `{ "*": verb }`, which matches any
 * sub-resource, so it covers the two that exist today and whatever the list
 * grows next.
 *
 * The second arm asks the projection rather than a list of open-ended roots
 * kept here. A list beside the grammar is a second answer to a question the
 * grammar already settles, and the way it fails is that the screen keeps
 * rendering while quietly going narrow about one pattern.
 */
export function isOpenEnded(scope: ParsedScope): boolean {
  if (scope.kind === "oidc" || scope.kind === "capability") return false;
  const pattern = scope.typePattern;
  if (pattern === GLOBAL_TYPE_WILDCARD) return true;
  if (subtreeWildcardRoot(pattern) !== null) return true;
  const projected = scopesToMetadataPermissions([
    `${pattern}:${scope.operation}`,
  ]);
  return projected["*"] !== undefined;
}

/**
 * The authorize screen's form: a toggle row's second line, set below the
 * label rather than joined to it, so it carries no closing period.
 */
export const OPEN_ENDED_LINE =
  "Covers what exists today plus anything added later";

/**
 * The device screen's form. That screen has no second line and no toggles:
 * it prints one sentence per grant and stops, so this is appended to the
 * description and has to end like a sentence.
 */
export const OPEN_ENDED_SENTENCE = "Also covers anything added later.";

/**
 * The tail an authorize-screen expansion line takes when the pattern it
 * enumerates is open-ended. The expansion names what the grant covers today,
 * which is the half a wildcard's own literal cannot say, so the futurity
 * clause joins that sentence instead of arriving as a third line beneath it.
 */
export const OPEN_ENDED_EXPANSION_TAIL = ", plus any you add later";
