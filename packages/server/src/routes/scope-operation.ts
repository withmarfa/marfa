/**
 * What a grant lets an application do, and the strings that say so.
 *
 * One derivation and two forms, in one module, for the reason
 * `scope-openness.ts` next door holds the same shape: the fact belongs to
 * the scope grammar, and it has to be stated on two surfaces that render
 * nothing alike. The authorize screen carries it on the row's name; the
 * device screen has no rows and appends a sentence.
 *
 * **Every term in the chains that resolve a row's copy is keyed on the type
 * pattern, and a type pattern carries no verb.** `SCOPE_LABELS`, the
 * description map and `humanizeType` all answer the same string for
 * `core.note:read` and `core.note:write`, so both rendered as "Notes" on one
 * screen and as "Your notes." on the other. The only thing telling them
 * apart was which section of the layout the row landed in, which is a
 * property of the arrangement rather than of the label: `summarize`
 * de-duplicated the two into one word, the device screen collapsed them into
 * one line, and the standing grant could not be shortened without losing the
 * distinction outright. A screen that cannot say an app may write to your
 * notes has failed at the one job it has.
 *
 * **Composed here rather than written into any copy map**, for the reason
 * the futurity clause is composed: a curated label is joined into a sentence
 * by `summarize`, a description is sometimes a label, and a fact spelled out
 * in two maps is a fact two maps can disagree about. Both screens ask this
 * module, so neither has to read English to find out whether the point has
 * already been made, and neither can go quiet about it while the other
 * speaks.
 *
 * **A write grant confers read, so the write form names both.**
 * `checkTypeAccess` refuses a write against a read grant and admits a read
 * against a write one; `edgePermissionCovers` and `metadataPermissionCovers`
 * say the same on their own axes. Naming only the second half would
 * understate the grant, and understating is the direction that makes
 * somebody approve more than they think they are approving.
 *
 * **The word is "write", not "change", and that is a decision rather than a
 * preference.** Two other surfaces already describe the same authority to
 * the same person: `/auth/security` says "read and write your data" about a
 * standing grant, and the self-serve key form offers "read and write your
 * content". A third word here would describe one grant two ways depending on
 * which screen a person happened to be looking at, and the security page is
 * where somebody goes to review a grant the consent screen took. "Change" is
 * also the weaker claim of the two: `DELETE /items/{id}` gates on write, and
 * the cascade planner takes an item's neighbors with it, so a person told an
 * app may change their notes has not been told it may delete them.
 */

import type { ParsedScope } from "@withmarfa/shared";

/** The two things a scope can permit. Verb-less families answer neither. */
type Operation = "read" | "write";

/**
 * What a scope permits, or `undefined` where the question does not arise.
 *
 * Asked of `kind` in an exhaustive switch rather than of the spelling, so a
 * family added to the grammar stops this package compiling until somebody has
 * decided whether a person reading its row is being told about a read or a
 * change. Spelling is what got this wrong elsewhere: the verb-less families
 * are exactly the ones whose literal carries no colon, and a rule derived
 * from the text would attach an operation to a permission by reading
 * the `operation` field that parsing gives every scope.
 */
export function scopeOperation(scope: ParsedScope): Operation | undefined {
  switch (scope.kind) {
    case "type":
    case "edge":
    case "metadata":
    case "content":
    case "profile":
      // `operation` is typed across the whole union, so the verb-less value
      // is refused here rather than defaulted to "read". A scope of a
      // verb-bearing kind carrying no verb is malformed, and answering for
      // it would put a claim on a consent screen that nothing checked.
      //
      // The content category joins this group rather than getting its own
      // arm: `content:read` and `content:write` carry a verb like any type
      // scope, and the breadth that makes the category different is a
      // question for `isOpenEnded`, not for this one. The exhaustiveness
      // guard below is what surfaced it: `content` would otherwise have
      // been answered `undefined`, which reads on the security page as a
      // family the page cannot characterize.
      return scope.operation === "none" ? undefined : scope.operation;
    case "oidc":
    case "permission":
      // Neither family reaches a permission map at all, so there is no
      // read/write axis to report. Attaching one would invent it.
      return undefined;
    default: {
      const _exhaustive: never = scope.kind;
      void _exhaustive;
      return undefined;
    }
  }
}

/**
 * The authorize screen's form: a parenthesis on the end of a row's name.
 *
 * Bracketed rather than joined, and that is the constraint rather than the
 * style. `summarize` joins these names into one sentence, where anything
 * reading as an item boundary splits a name in two — which is why no entry
 * in `SCOPE_LABELS` may carry a comma or an "and". The brackets are what
 * let the write form carry a conjunction and still arrive as one item.
 */
const OPERATION_SUFFIX: Record<Operation, string> = {
  read: " (read only)",
  write: " (read and write)",
};

/**
 * The device screen's form, and the group summary's: a sentence of its own.
 *
 * That screen prints one line per grant and has no second line to put this
 * on, so it lands as a sentence after the description. The group summary
 * takes the same string where every scope in a group permits the same thing,
 * which is what keeps the two surfaces stating one grant in one vocabulary.
 */
const OPERATION_SENTENCE: Record<Operation, string> = {
  read: "Read only.",
  write: "Read and write.",
};

/**
 * A row's name with what the row permits attached, or the name unchanged
 * where the scope permits neither.
 *
 * Applied over the whole label chain rather than inside it, so the
 * humanized floor an uncurated pattern falls to carries the operation as
 * well. A distinction that held only for the curated set would be no
 * distinction: a third-party app's custom request is exactly the grant a
 * person has least other information about.
 */
export function withOperation(scope: ParsedScope, name: string): string {
  const operation = scopeOperation(scope);
  return operation === undefined
    ? name
    : `${name}${OPERATION_SUFFIX[operation]}`;
}

/** The device screen's sentence for one scope, or `undefined` where the
 *  scope permits neither. */
export function operationSentence(scope: ParsedScope): string | undefined {
  const operation = scopeOperation(scope);
  return operation === undefined ? undefined : OPERATION_SENTENCE[operation];
}

/**
 * The sentence for a set every member of which permits the same thing, or
 * `undefined` where they do not agree or where any member permits neither.
 *
 * A group summary describes a group, so a property every member shares is
 * stated once about the group instead of repeated on each name: "Notes,
 * Tasks and Calendar. Read only." rather than the same parenthesis four
 * times in one sentence. Where the members disagree — which is what a
 * merged section is — there is nothing true of the group, and the caller
 * falls back to marking each name.
 *
 * A verb-less member collapses the answer for the same reason. `openid`
 * beside `core.note:read` makes "Read only." false of the group, and a
 * sentence that is true of most of a list is the kind of copy this screen
 * has been wrong with before.
 */
export function sharedOperationSentence(
  scopes: readonly ParsedScope[],
): string | undefined {
  let shared: Operation | undefined;
  for (const scope of scopes) {
    const operation = scopeOperation(scope);
    if (operation === undefined) return undefined;
    if (shared === undefined) shared = operation;
    else if (shared !== operation) return undefined;
  }
  return shared === undefined ? undefined : OPERATION_SENTENCE[shared];
}
