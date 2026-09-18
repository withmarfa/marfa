import { ErrorCode, MarfaError, getTypeSchema } from "@withmarfa/shared";

/**
 * How deep a registered type's parent chain may go.
 *
 * Three routes run this check and have to agree on which chains are legal:
 * `POST /types`, `PUT /types/:id` and the archive restore. They previously
 * agreed by the two files holding a copy of this number each, with a comment
 * in one claiming to mirror the other. Nothing made that true, and the two
 * ways it could have gone wrong fail differently:
 *
 * - **A stricter archive cap** rejects partway through a restore, because
 *   the restore writes types one at a time and outside a transaction, so
 *   earlier entries have already landed when a later one is refused.
 * - **A stricter registration cap** rejects nothing at restore time. The
 *   archive quietly accepts a chain `POST /types` would refuse, and the
 *   disagreement shows up later at a registration, or never.
 *
 * A third path shares it now. Manifest registration checked nothing about a
 * parent chain until it was given this one, and it writes its declared
 * schemas parents-first, so a manifest may list a child before its parent
 * and still be checked against the same cap as the other two.
 *
 * Distinct from `MAX_RESOLUTION_DEPTH` in `@withmarfa/shared`. That one is
 * the backstop every resolution walk stops at, whatever produced the chain,
 * and its declaration carries the relationship between the two. This is the
 * bound on what one checked registration may produce, and it sits well below
 * the backstop deliberately.
 *
 * On its own it bounds only the chain above the type being written, which
 * is not the same as the chain the write produces. Re-parenting a type that
 * has subtypes lengthens every one of their chains without any of them being
 * submitted, so ten updates that each pass can take a chain past a cap that
 * would have refused building it directly. `descendantDepth` is what closes
 * that: the caller measures what sits below and the two halves are bounded
 * together.
 */
export const MAX_REGISTRATION_CHAIN_DEPTH = 10;

/** How a caller phrases the three ways a parent chain can be rejected. */
export interface ParentChainMessages {
  tooDeep: (maxDepth: number) => string;
  circular: () => string;
  /**
   * Receives the first ancestor that failed to resolve AND the parent the
   * caller supplied. They are the same id only when the chain is one link
   * long, and a message phrased on the first alone tells a caller their
   * parent is missing when it resolves perfectly well and its own parent is
   * the problem.
   */
  unknownParent: (unresolvedId: string, parentId: string) => string;
}

/**
 * A parent chain must terminate, must not reach back to the type being
 * registered, and must resolve every ancestor within the caller's space.
 *
 * Parents resolve space-scoped so a custom type may inherit from another
 * of the space's custom types as well as from a core one.
 *
 * The messages differ by door because they are read in different contexts:
 * a restore names the offending archive entry, since the caller did not
 * hand over that type individually and needs telling which one it was.
 */
export function assertParentChain(
  typeId: string,
  parentId: string,
  messages: ParentChainMessages,
  /**
   * How many levels of subtype sit below `typeId`, which the resulting chain
   * carries as surely as the ancestors above it. Zero for a type nothing
   * inherits from, which is every registration of a new type.
   */
  descendantDepth = 0,
): void {
  let current = parentId;
  let depth = 0;
  while (current) {
    depth += 1;
    if (depth + descendantDepth > MAX_REGISTRATION_CHAIN_DEPTH) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        messages.tooDeep(MAX_REGISTRATION_CHAIN_DEPTH),
      );
    }
    if (current === typeId) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, messages.circular());
    }
    const parent = getTypeSchema(current);
    if (!parent) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        messages.unknownParent(current, parentId),
      );
    }
    if (!parent.parent) break;
    current = parent.parent;
  }
}
