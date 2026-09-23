import type { TypeSchema, FieldDefinition } from "@withmarfa/types";

/**
 * Classifies the diff between two type schemas.
 *
 * - `noop` — schemas are structurally identical; submitting again is rejected.
 * - `patch` — descriptive-only change (label, description, field
 *   descriptions). Same version permitted on re-submission.
 * - `minor` — additive or widening change (optional field added, a cap raised,
 *   a compatibility claim gained). Requires a version bump.
 * - `major` — breaking change (field removed, shape changed, a cap lowered, a
 *   compatibility claim withdrawn, or required tightened). Requires a bump.
 *
 * Integer versions collapse minor and major into "must bump", but the
 * classifier still returns the granular class so error messages and
 * telemetry can surface it.
 *
 * Every attribute the field model carries is compared. An attribute the diff
 * ignores is an attribute a caller can change without a version bump, which
 * leaves consumers pinned to a version that no longer describes the data.
 */
export type DiffClass = "noop" | "patch" | "minor" | "major";

/** How a single field changed, ignoring its description. */
type FieldDiff = "same" | "widened" | "breaking";

/**
 * Attributes that define what a field *is*. Any change to one of these
 * reshapes data that already exists, so it is breaking regardless of
 * direction.
 */
const SHAPE_ATTRIBUTES = ["type", "items_type", "format"] as const;

function diffField(a: FieldDefinition, b: FieldDefinition): FieldDiff {
  for (const attribute of SHAPE_ATTRIBUTES) {
    if (a[attribute] !== b[attribute]) return "breaking";
  }
  if ((a.enum_values?.join("|") ?? "") !== (b.enum_values?.join("|") ?? "")) {
    return "breaking";
  }
  if ((a.required ?? false) !== (b.required ?? false)) {
    // Tightening rejects existing rows; loosening changes the contract every
    // reader was compiled against. Both earn a bump, and neither is a widening
    // a consumer can ignore.
    return "breaking";
  }
  // The FTS opt-out changes which rows a search returns without changing what
  // validates, so it is a behavior change rather than a breaking one.
  if ((a.searchable ?? true) !== (b.searchable ?? true)) return "widened";

  const capDiff = diffCaps(a, b);
  if (capDiff !== "same") return capDiff;

  return "same";
}

/**
 * Per-field size caps move in two directions with different consequences:
 * raising one accepts strictly more than before, lowering one starts rejecting
 * writes that used to succeed.
 */
function diffCaps(a: FieldDefinition, b: FieldDefinition): FieldDiff {
  let widened = false;
  for (const cap of ["maxLength", "maxItems"] as const) {
    const before = a[cap];
    const after = b[cap];
    if (before === after) continue;
    // An omitted cap means "the instance default", whose value is not
    // knowable from the schema alone. Treat adding or removing one as
    // breaking rather than guess which side is more permissive.
    if (before === undefined || after === undefined) return "breaking";
    if (after < before) return "breaking";
    widened = true;
  }
  return widened ? "widened" : "same";
}

/**
 * `compatible_with` is typed `string[]`, but the validator accepts a bare
 * string as the single-target shorthand, and custom types registered before it
 * normalized are stored that way. Reading one back and handing it to `new Set`
 * would iterate its characters, so every target would look withdrawn and an
 * untouched claim would report as breaking.
 */
function compatibleWithTargets(schema: TypeSchema): Set<string> {
  const declared: unknown = schema.compatible_with;
  if (typeof declared === "string") return new Set([declared]);
  if (!Array.isArray(declared)) return new Set();
  return new Set(declared.filter((t): t is string => typeof t === "string"));
}

function compatibleWithDiff(prev: TypeSchema, next: TypeSchema): FieldDiff {
  const before = compatibleWithTargets(prev);
  const after = compatibleWithTargets(next);
  // Withdrawing a claim breaks every reader that relied on this type being
  // readable as the target; adding one only offers more.
  for (const target of before) if (!after.has(target)) return "breaking";
  for (const target of after) if (!before.has(target)) return "widened";
  return "same";
}

/**
 * Withdrawing a role is breaking in a way a withdrawn field is not: every edge
 * constraining on that role stops accepting the type, so writes that used to
 * land start refusing. Declaring one only ever admits more.
 */
function rolesDiff(prev: TypeSchema, next: TypeSchema): FieldDiff {
  const before = new Set(prev.roles ?? []);
  const after = new Set(next.roles ?? []);
  for (const role of before) if (!after.has(role)) return "breaking";
  for (const role of after) if (!before.has(role)) return "widened";
  return "same";
}

/**
 * Compute the diff class between an existing schema and a proposed new
 * version. Used by `POST /types` to gate the version bump.
 */
export function diffTypeSchemas(prev: TypeSchema, next: TypeSchema): DiffClass {
  let major = false;
  let minor = false;
  let descriptive = false;

  const prevFields = prev.fields;
  const nextFields = next.fields;

  for (const [name, prevField] of Object.entries(prevFields)) {
    const nextField = nextFields[name];
    if (!nextField) {
      major = true;
      continue;
    }
    const diff = diffField(prevField, nextField);
    if (diff === "breaking") {
      major = true;
      continue;
    }
    if (diff === "widened") minor = true;
    if (prevField.description !== nextField.description) descriptive = true;
  }

  // Required additions are major — they tighten validation for existing items.
  for (const [name, nextField] of Object.entries(nextFields)) {
    if (prevFields[name]) continue;
    if (nextField.required === true) {
      major = true;
    } else {
      minor = true;
    }
  }

  const compatibility = compatibleWithDiff(prev, next);
  if (compatibility === "breaking") major = true;
  else if (compatibility === "widened") minor = true;

  const roles = rolesDiff(prev, next);
  if (roles === "breaking") major = true;
  else if (roles === "widened") minor = true;

  if (prev.parent !== next.parent) major = true;

  if (
    prev.display_hints?.title_field !== next.display_hints?.title_field ||
    prev.display_hints?.body_field !== next.display_hints?.body_field
  ) {
    descriptive = true;
  }

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
