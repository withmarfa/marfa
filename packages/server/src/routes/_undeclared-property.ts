import {
  ErrorCode,
  MarfaError,
  getResolvedFields,
  getTypeSchema,
  isTypeInStrictMode,
} from "@withmarfa/shared";
import type { EnforcementSettings } from "@withmarfa/shared";

/**
 * The strict-mode lever, as the item write doors ask it: `POST /items`,
 * `POST /items/bulk` on both halves of an upsert, `PATCH /items/{id}` and
 * `POST /admin/restore-archive`.
 *
 * **One reading, because the lever belongs to the type and not to the
 * door.** The store's own `validateProperties` runs loose whatever the
 * configuration says, so a door that writes through the store has to ask
 * above it or not at all, and two doors asking separately are two doors
 * free to drift. The filter-in door `POST /items/bulk-actions` with
 * `update_properties` still writes through the store without asking, and
 * is recorded as an open question rather than claimed here.
 *
 * **The properties the caller sent, not the merge they land in.** An
 * update measured against the merged result would refuse every write to a
 * row that already carries an undeclared property from before the lever
 * was set, which is a different rule from the one the create door
 * enforces. What the lever refuses is a caller introducing one.
 *
 * **Undeclared keys and nothing else, asked of the declared field set
 * rather than of a strict parse.** A strict parse answers two questions at
 * once: it refuses a key the type does not declare, and it refuses a
 * property set missing a field the type requires. The second is the
 * store's to ask, and asking it here refused an ordinary partial update —
 * a `PATCH` setting a title on a `core.note` names no `body`, so a strict
 * parse of the patch reports the required field as an error and this
 * function would refuse the write under a message naming a cause that is
 * not the cause. The doors that hand over a complete property set never
 * saw it; the two that hand over a patch see it on nearly every request.
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
  const declared = getResolvedFields(type);
  if (declared === undefined) return null;
  const undeclared = Object.keys(properties).filter(
    (name) => !Object.prototype.hasOwnProperty.call(declared, name),
  );
  if (undeclared.length === 0) return null;
  return new MarfaError(
    ErrorCode.INVALID_PROPERTIES,
    "Unknown property: strict mode rejects properties not declared in the type schema",
    {
      ...details,
      errors: undeclared.map((name) => ({
        field: name,
        message: `Unrecognized key: "${name}"`,
      })),
      code: "unknown_property",
    },
  );
}
