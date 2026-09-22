import {
  ErrorCode,
  MarfaError,
  getTypeSchema,
  isTypeInStrictMode,
  validateProperties,
} from "@withmarfa/shared";
import type { EnforcementSettings } from "@withmarfa/shared";

/**
 * The strict-mode lever, as every door that writes caller-supplied
 * properties asks it: `POST /items`, `POST /items/bulk` on both halves of
 * an upsert, `PATCH /items/{id}` and `POST /admin/restore-archive`.
 *
 * **One reading, because the lever belongs to the type and not to the
 * door.** The store's own `validateProperties` runs loose whatever the
 * configuration says, so a door that writes through the store has to ask
 * above it or not at all, and two doors asking separately are two doors
 * free to drift.
 *
 * **The properties the caller sent, not the merge they land in.** An
 * update measured against the merged result would refuse every write to a
 * row that already carries an undeclared property from before the lever
 * was set, which is a different rule from the one the create door
 * enforces. What the lever refuses is a caller introducing one.
 *
 * Returns the refusal rather than throwing it, because the callers answer
 * differently: the create doors throw into the error handler, the restore
 * hands it to its own `refuse`, which clears the request's spool files
 * before answering, and the bulk door's update half returns it as that
 * entry's `errored` outcome.
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
