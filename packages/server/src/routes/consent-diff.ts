import { grantCoversScope } from "@withmarfa/shared";

/**
 * Re-consent diff.
 *
 * Pure function. Given the scope set the user previously approved on
 * this client and the scope set the client is requesting now, returns
 * three groups: scopes the standing grant already covers (`kept`),
 * scopes it does not (`added`), and scopes the standing grant carries
 * that the new request would not cover (`removed`).
 *
 * **Coverage, not set difference, and the docblock here used to say the
 * opposite.** It asked the caller to expand wildcards before handing
 * anything over, which cannot be done: `core.*:read` expands only against
 * the live type registry, and expanded it renders as forty tiles rather
 * than one. So nothing expanded anything, and the screen compared text. A
 * user holding `core.*:read` was shown a later request for `core.note:read`
 * under "New" — access they already had — while the standing grant appeared
 * under a line saying it was being dropped. Both halves wrong, on the one
 * screen whose whole job is to say accurately what is about to change.
 *
 * The asymmetry is deliberate and is why this cannot be one set operation:
 * `kept` and `added` ask whether the OLD grant covers each NEW scope, and
 * `removed` asks whether the NEW request covers each OLD one. A request
 * that widens therefore removes nothing, and a request that narrows still
 * says so.
 *
 * `grantCoversScope` is imported rather than taken as a parameter. Injecting
 * it would keep this module free of the scope grammar, which is the tidier
 * shape and was considered; it was rejected because a screen where a person
 * makes a security decision should have one behaviour rather than a
 * configurable one. There is one caller and there has never been an
 * injection point.
 */

export interface ConsentDiff {
  /** Scopes in `next` that the `prev` grant already covers. */
  kept: string[];
  /** Scopes in `next` that the `prev` grant does not cover. */
  added: string[];
  /** Scopes in `prev` that `next` would not cover. */
  removed: string[];
}

/**
 * Compute the diff between a prior set of approved scopes and a newly
 * requested set. Output arrays preserve the input ordering of `next`
 * (for `kept` + `added`) and `prev` (for `removed`), and de-duplicate.
 *
 * The caller looks each returned literal back up in a map built from its
 * own inputs, so `kept` and `added` are drawn from `next` and `removed`
 * from `prev` — a covering literal is never substituted for the literal
 * that was actually asked for.
 */
export function computeConsentDiff(
  prev: readonly string[],
  next: readonly string[],
): ConsentDiff {
  const kept: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const seenKept = new Set<string>();
  const seenAdded = new Set<string>();
  const seenRemoved = new Set<string>();

  for (const scope of next) {
    if (grantCoversScope(prev, scope)) {
      if (!seenKept.has(scope)) {
        kept.push(scope);
        seenKept.add(scope);
      }
    } else if (!seenAdded.has(scope)) {
      added.push(scope);
      seenAdded.add(scope);
    }
  }
  for (const scope of prev) {
    if (!grantCoversScope(next, scope) && !seenRemoved.has(scope)) {
      removed.push(scope);
      seenRemoved.add(scope);
    }
  }
  return { kept, added, removed };
}
