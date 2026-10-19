import {
  ErrorCode,
  MarfaError,
  listTypes,
  validateTypeSchema,
  type SchemaValidationIssue,
} from "@withmarfa/shared";

export function compatibilityDependents(id: string): string[] {
  return listTypes()
    .filter(
      (schema) => schema.id !== id && schema.compatible_with?.includes(id),
    )
    .map((schema) => schema.id)
    .sort();
}

/** Call after staging the change, inside the transaction that commits it. */
export function assertCompatibleDependents(
  changedIds: readonly string[],
): void {
  const schemas = listTypes();
  const affected = new Set(changedIds);
  // A parent's shape changes both the promises its descendants make and
  // the promises other registrations make about those descendants.
  let grew = true;
  while (grew) {
    grew = false;
    for (const schema of schemas) {
      if (
        schema.parent &&
        affected.has(schema.parent) &&
        !affected.has(schema.id)
      ) {
        affected.add(schema.id);
        grew = true;
      }
    }
  }
  const errors: SchemaValidationIssue[] = [];
  const dependents: string[] = [];
  for (const schema of schemas) {
    if (!schema.compatible_with?.length) continue;
    if (
      !affected.has(schema.id) &&
      !schema.compatible_with.some((id) => affected.has(id))
    )
      continue;
    const result = validateTypeSchema(schema);
    if (result.success) continue;
    const violations = result.errors.filter(
      (error) => error.code === "compatible_with_violation",
    );
    if (!violations.length) continue;
    dependents.push(schema.id);
    errors.push(
      ...violations.map((error) => ({
        ...error,
        field: `types.${schema.id}.${error.field}`,
      })),
    );
  }
  if (dependents.length) {
    dependents.sort();
    throw new MarfaError(
      ErrorCode.COMPATIBLE_WITH_VIOLATION,
      `Change would break compatible_with for: ${dependents.join(", ")}`,
      { dependent_type_ids: dependents, errors },
    );
  }
}
