import { inheritedShapeConflicts, listTypes } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";

/**
 * The conflicts of one registered type. A stored definition that cannot be
 * compared is skipped and named in the log, so one bad row neither stops the
 * boot nor hides another type's conflicts. The line carries the type's id and
 * the failure's class, never a definition or an item.
 */
export function shapeConflictsOf(
  typeId: string,
): ReturnType<typeof inheritedShapeConflicts> {
  try {
    return inheritedShapeConflicts(typeId);
  } catch (error) {
    log("warn", "a registered type could not be checked for shape conflicts", {
      type: typeId,
      error: error instanceof Error ? error.name : typeof error,
      effect: "the type is left out of the conflict check",
    });
    return [];
  }
}

/**
 * Report registered types that declare a field in another shape than a type
 * above them, once the registry holds what the rows say.
 *
 * **A conflict means a type above gained or changed a field after the type
 * below it was registered.** A registration is held to that rule
 * (`types/child-shape`); a build that ships a type above a stored one is not
 * held to it by anything, so the stored type arrives already in conflict.
 *
 * **Reported rather than resolved, for the reason the seed collisions are.**
 * Rewriting a stored type would change what its connector registered, and
 * refusing to boot would take an instance down for a condition that harms
 * no item: the type keeps resolving as stored. `GET /types` lists the same
 * conflicts from the live registry, so they clear without a restart.
 *
 * The line names types and fields, never an item or a value.
 */
export function reportTypeShapeConflicts(): void {
  const conflicts = listTypes().flatMap((schema) =>
    shapeConflictsOf(schema.id).map((conflict) => ({
      type: schema.id,
      ...conflict,
    })),
  );
  if (conflicts.length === 0) return;
  log(
    "warn",
    "registered types declare fields in a shape a type above them declares differently",
    {
      count: conflicts.length,
      conflicts,
      effect:
        "the types keep resolving and their items stay readable; registering one again as it stands is refused until the shapes agree",
      action:
        "update the connector that registers each type to the shape above, then register it again",
    },
  );
}
