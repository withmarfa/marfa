import { ErrorCode, MarfaError, getTypeSchema } from "@withmarfa/shared";

/**
 * How deep a registered type's parent chain may go.
 *
 * Three routes run this check and have to agree on which chains are legal:
 * `POST /types`, `PUT /types/:id` and the archive restore. One number rather
 * than a copy each, because the two ways they could disagree fail
 * differently:
 *
 * - **A stricter archive cap** rejects partway through a restore, because
 *   the restore writes types one at a time, each in a transaction of its
 *   own, so earlier entries have already landed when a later one is refused.
 * - **A stricter registration cap** rejects nothing at restore time. The
 *   archive quietly accepts a chain `POST /types` would refuse, and the
 *   disagreement shows up later at a registration, or never.
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
 * registered, and must resolve every ancestor through the registry.
 *
 * Parents resolve through the registry so a custom type may inherit from
 * another runtime-registered type as well as from a core one.
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
