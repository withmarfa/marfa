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
 * It does not bound a chain's final depth. Re-parenting through
 * `PUT /types/:id` walks upward from the type being changed and revalidates
 * none of its descendants, so a chain can be grown past this cap, and past
 * the backstop above it, in steps that each pass.
 */
export const MAX_REGISTRATION_CHAIN_DEPTH = 10;

/** How a caller phrases the three ways a parent chain can be rejected. */
export interface ParentChainMessages {
  tooDeep: (maxDepth: number) => string;
  circular: () => string;
  /**
   * Receives the first ancestor that failed to resolve, which is the parent
   * the caller supplied only when the chain is one link long.
   */
  unknownParent: (unresolvedId: string) => string;
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
  spaceId: string | undefined,
  messages: ParentChainMessages,
): void {
  let current = parentId;
  let depth = 0;
  while (current) {
    depth += 1;
    if (depth > MAX_REGISTRATION_CHAIN_DEPTH) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        messages.tooDeep(MAX_REGISTRATION_CHAIN_DEPTH),
      );
    }
    if (current === typeId) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, messages.circular());
    }
    const parent = getTypeSchema(current, spaceId);
    if (!parent) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        messages.unknownParent(current),
      );
    }
    if (!parent.parent) break;
    current = parent.parent;
  }
}
