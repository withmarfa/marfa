import type { TypeSchema, FieldDefinition } from "@mymehq/types";

/**
 * Classifies the diff between two type schemas (TSC42 §7).
 *
 * - `noop` — schemas are structurally identical; submitting again is rejected.
 * - `patch` — descriptive-only change (label, description, field
 *   descriptions). Same version permitted on re-submission.
 * - `minor` — additive change (optional field added). Requires a version
 *   bump.
 * - `major` — breaking change (field removed, type changed, or required-
 *   tightened). Requires a version bump.
 *
 * Integer versions (the current wire shape) collapse minor and major into
 * "must bump", but the classifier still returns the granular class so error
 * messages and SDK telemetry can surface it.
 */
export type DiffClass = "noop" | "patch" | "minor" | "major";

function fieldDefinitionsEquivalent(
  a: FieldDefinition,
  b: FieldDefinition,
): boolean {
  if (a.type !== b.type) return false;
  if ((a.required ?? false) !== (b.required ?? false)) return false;
  if (a.items_type !== b.items_type) return false;
  const aEnum = a.enum_values?.join("|") ?? "";
  const bEnum = b.enum_values?.join("|") ?? "";
  return aEnum === bEnum;
}

function fieldsAreDescriptiveOnlyDiff(
  a: FieldDefinition,
  b: FieldDefinition,
): boolean {
  // Same structural shape but one of `description` differs: descriptive-only.
  if (!fieldDefinitionsEquivalent(a, b)) return false;
  return a.description !== b.description;
}

/**
 * Compute the diff class between an existing schema and a proposed new
 * version. Used by `POST /types` to gate the version bump.
 */
export function diffTypeSchemas(
  prev: TypeSchema,
  next: TypeSchema,
): DiffClass {
  // Walk every field on prev — removals or required-tightening or type
  // changes are major.
  let major = false;
  let minor = false;
  let descriptive = false;

  const prevFields = prev.fields ?? {};
  const nextFields = next.fields ?? {};

  for (const [name, prevField] of Object.entries(prevFields)) {
    const nextField = nextFields[name];
    if (!nextField) {
      major = true;
      continue;
    }
    if (!fieldDefinitionsEquivalent(prevField, nextField)) {
      major = true;
      continue;
    }
    if (fieldsAreDescriptiveOnlyDiff(prevField, nextField)) {
      descriptive = true;
    }
  }

  // Walk new fields — additions are at least minor; required additions are
  // major (would tighten validation for existing items).
  for (const [name, nextField] of Object.entries(nextFields)) {
    if (prevFields[name]) continue;
    if (nextField.required === true) {
      major = true;
    } else {
      minor = true;
    }
  }

  // Top-level descriptive fields (label, description) — not breaking.
  if (prev.label !== next.label || prev.description !== next.description) {
    descriptive = true;
  }

  if (major) return "major";
  if (minor) return "minor";
  if (descriptive) return "patch";
  return "noop";
}

/**
 * Whether the proposed `nextVersion` is a valid version bump given the
 * diff class. With integer versions, anything other than a no-op requires
 * `nextVersion > prevVersion`. A pure descriptive (patch) change permits
 * the same version on re-submission so docs can be tweaked without forcing
 * consumers to re-pin.
 */
export function isValidVersionBump(
  diff: DiffClass,
  prevVersion: number,
  nextVersion: number,
): boolean {
  if (diff === "noop") return false;
  if (diff === "patch") return nextVersion >= prevVersion;
  return nextVersion > prevVersion;
}
