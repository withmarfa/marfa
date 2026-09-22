import {
  ErrorCode,
  MarfaError,
  getTypeSchema,
  isTypeInStrictMode,
  validateProperties,
} from "@withmarfa/shared";
import type { EnforcementSettings } from "@withmarfa/shared";

/**
 * The strict-mode lever, asked the same way by every door that writes
 * properties.
 *
 * **One reading, because the lever belongs to the type and not to the
 * door.** The store's own `validateProperties` runs loose whatever the
 * configuration says, so the refusal lives above it — and it lived in
 * `POST /items`' handler alone, which made an archive the way around a
 * control the create door enforces: `POST /admin/restore-archive` writes
 * through the store directly, so a property no type declares landed, and
 * a read afterwards served it back unmarked under the type's current
 * version. A second copy of the check in the restore would be the same
 * hazard one refactor later, so both doors ask this.
 *
 * Returns the refusal rather than throwing it, because the two callers
 * answer differently: the create door throws into the error handler, and
 * the restore collects the refusal so it can undo the blobs it has
 * already written before answering.
 *
 * A type with no shipped schema is left alone: there is nothing to
 * measure "undeclared" against, and a lever naming such a type would
 * otherwise refuse every property it has.
 */
export function undeclaredPropertyRefusal(
  enforcement: EnforcementSettings,
  type: string,
  properties: Record<string, unknown>,
  /** Merged into `error.details`, so a caller reading a refused batch can
   *  tell which row it came from. */
  details: Record<string, unknown> = {},
): MarfaError | null {
  if (!isTypeInStrictMode(enforcement, type)) return null;
  if (getTypeSchema(type) === undefined) return null;
  const result = validateProperties(type, properties, { strict: true });
  if (result.success) return null;
  return new MarfaError(
    ErrorCode.INVALID_PROPERTIES,
    "Unknown property: strict mode rejects properties not declared in the type schema",
    { ...details, errors: result.errors, code: "unknown_property" },
  );
}
