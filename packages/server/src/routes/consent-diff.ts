/**
 * Re-consent diff (Wave C PR5 / T-032).
 *
 * Pure function. Given the scope set the user previously approved on
 * this client and the scope set the client is requesting now, returns
 * three groups: scopes that are unchanged (`kept`), scopes that are
 * new in the request (`added`), and scopes the previous grant carried
 * but the new request omits (`removed`).
 *
 * Scopes are compared as opaque literals (`<typePattern>:<verb>`).
 * The caller does any expansion (wildcards, OAuth-grammar-canonical-
 * isation) BEFORE handing to this function — `computeConsentDiff` is
 * a set-difference helper and nothing more.
 */

export interface ConsentDiff {
  /** Scopes present in BOTH `prev` and `next`. */
  kept: string[];
  /** Scopes in `next` but not in `prev`. */
  added: string[];
  /** Scopes in `prev` but not in `next`. */
  removed: string[];
}

/**
 * Compute the diff between a prior set of approved scopes and a newly
 * requested set. Output arrays preserve the input ordering of `next`
 * (for `kept` + `added`) and `prev` (for `removed`), and de-duplicate.
 */
export function computeConsentDiff(
  prev: readonly string[],
  next: readonly string[],
): ConsentDiff {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const kept: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const seenKept = new Set<string>();
  const seenAdded = new Set<string>();
  const seenRemoved = new Set<string>();

  for (const scope of next) {
    if (prevSet.has(scope)) {
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
    if (!nextSet.has(scope) && !seenRemoved.has(scope)) {
      removed.push(scope);
      seenRemoved.add(scope);
    }
  }
  return { kept, added, removed };
}
