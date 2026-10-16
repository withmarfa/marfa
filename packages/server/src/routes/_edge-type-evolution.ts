import { isDeepStrictEqual } from "node:util";
import { ErrorCode, MarfaError, type EdgeTypeSchema } from "@withmarfa/shared";

const unrestricted = (values: readonly string[]) =>
  values.length === 0 || values.includes("*");

function widens(stored: readonly string[], next: readonly string[]): boolean {
  if (unrestricted(next)) return true;
  if (unrestricted(stored)) return false;
  // Retain symbolic tokens so future subtypes and role members stay admitted.
  return stored.every((value) => next.includes(value));
}

export function assertConstraintEvolution(
  stored: EdgeTypeSchema,
  next: EdgeTypeSchema,
): void {
  const changes: string[] = [];
  for (const key of [
    "id",
    "label",
    "description",
    "cardinality",
    "cascade_on_delete",
    "property_schema",
    "reverse_name",
    "written_at",
  ] as const) {
    if (!isDeepStrictEqual(stored[key], next[key])) changes.push(key);
  }
  for (const key of [
    "source_type_constraints",
    "target_type_constraints",
  ] as const) {
    if (!widens(stored[key], next[key])) changes.push(key);
  }
  if (changes.length > 0)
    throw new MarfaError(
      ErrorCode.CONFLICT,
      "Constraint evolution may only add endpoint constraint tokens or allow every type; every other definition member must stay unchanged",
      { edge_type: stored.id, changes },
    );
}
