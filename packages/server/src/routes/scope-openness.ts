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
 *
 * **Every kind is named, and none falls through.** This function used to
 * refuse two kinds and send everything else down the pattern path, which read
 * as "the pattern path is the general case" and behaved as "whatever nobody
 * has classified is assumed concrete". The content category is what that
 * assumption cost: its pattern is the bare word `content`, which is not the
 * global wildcard, carries no `.*`, and projects nothing into the metadata
 * map, so the widest grant the grammar can express answered `false` and both
 * screens went silent about its reach. Nothing failed to compile, because
 * there was nothing here to fail. A `never` on the default arm is that
 * missing thing: a seventh kind now stops this package building until someone
 * has decided whether it reaches things that do not exist yet.
 */
export function isOpenEnded(scope: ParsedScope): boolean {
  switch (scope.kind) {
    case "oidc":
    case "permission":
      // No pattern and no verb between them. An OIDC literal names a claim
      // set and a permission names one administrative surface; neither
      // reaches anything registered later, because neither reaches anything
      // registered at all.
      return false;
    case "content":
      // **Yes, and it is the widest yes in the grammar.** The category is
      // defined as the complement of the system family rather than as a list,
      // so it reaches every non-system type including those
      // registered after the grant was made — which is exactly the property
      // the two sentences below exist to state.
      //
      // Answered here rather than derived, because neither derivation below
      // can reach it: the pattern is the bare word `content`, so the wildcard
      // arms do not fire, and the category projects into `type_permissions`
      // rather than into the metadata map, so the projection arm sees an
      // empty object. This is the arm whose absence was the defect.
      return true;
    case "profile":
      // Answered by the family rather than by the spelling, because this
      // category's breadth is carried by which form the literal takes rather
      // than by a wildcard in it. `profile:<verb>` reaches the whole category
      // INCLUDING rows added to it later, which is the definition this
      // predicate exists to state; `profile.<row>:<verb>` reaches exactly one
      // row and can never widen.
      //
      // Deriving it from the pattern the way the three below do would answer
      // false for both, since neither literal carries an asterisk and neither
      // projects into the metadata map.
      return scope.profileRow === undefined;
    case "type":
    case "edge":
    case "metadata": {
      // The three pattern-bearing kinds, and the only ones where the question
      // is decided by the spelling rather than by the family.
      const pattern = scope.typePattern;
      if (pattern === GLOBAL_TYPE_WILDCARD) return true;
      if (subtreeWildcardRoot(pattern) !== null) return true;
      const projected = scopesToMetadataPermissions([
        `${pattern}:${scope.operation}`,
      ]);
      return projected["*"] !== undefined;
    }
    default: {
      // Compile-time exhaustiveness, matching `isTypeScope` and
      // `grantCoversScope` in the shared package. A kind added to the union
      // stops this compiling until somebody answers for it, rather than
      // inheriting an answer from whichever arm happens to catch it.
      const _exhaustive: never = scope.kind;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * The authorize screen's form: a toggle row's second line, set below the
 * label rather than joined to it, so it carries no closing period.
 */
export const OPEN_ENDED_LINE =
  "Covers what exists today plus anything added later";

/**
 * The device screen's form. That screen has no second line: it prints one
 * sentence per grant beside its toggle and stops, so this is appended to the
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
