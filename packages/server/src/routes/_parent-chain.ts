import { ErrorCode, MarfaError, getTypeSchema } from "@withmarfa/shared";

/**
 * How deep a registered type's parent chain may go.
 *
 * Three routes run this check and have to agree on which chains are legal:
 * `POST /types`, `PUT /types/:id` and the archive restore. They previously
 * agreed by the two files holding a copy of this number each, with a comment
 * in one saying it mirrored the other. Nothing made that true:
 * changing one would have left the archive able to carry a type
 * registration would refuse, or refusing one registration allows, and the
 * disagreement would first surface as a confusing rejection partway through
 * a restore.
 *
 * These are not the only paths that put a schema into the registry. Manifest
 * registration writes declared schemas without checking a parent chain at
 * all, which is its own defect rather than something this file closes.
 *
 * Distinct from the registry's own `MAX_INHERITANCE_DEPTH` of 100 in
 * `@withmarfa/shared`. That one is a generous runtime backstop on the
 * resolution walks, sized so a real hierarchy never reaches it. This is the
 * bound on what a caller may register in one step, and it sits well below
 * the backstop deliberately.
 *
 * It does not bound a chain's final depth. Re-parenting through
 * `PUT /types/:id` walks upward from the type being changed and revalidates
 * none of its descendants, so a chain can be grown past this cap, and past
 * the backstop above it, in steps that each pass.
 */
export const MAX_INHERITANCE_DEPTH = 10;

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
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        messages.tooDeep(MAX_INHERITANCE_DEPTH),
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
