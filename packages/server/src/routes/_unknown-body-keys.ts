/**
 * Refusing a filter field or a request field the door does not declare, and
 * the judgment in doing it at all.
 *
 * The request validator strips keys it does not declare rather than
 * rejecting them, so a caller who misspells a field gets a successful
 * response as if the field had never been sent. There is no status, no
 * warning and no field in the response that separates that from a field
 * left at its default.
 *
 * On `POST /items/bulk-actions` the filter *is* the match set, so a dropped
 * key turns `{action: "purge", filter: {occurred_before: "..."}}` into a
 * purge with an empty filter — every item, and under the match cap it does
 * not even error.
 *
 * The same door's *envelope* is worse again, and is the one that reads as
 * out of scope until it is written down: `dry_run` is taken as
 * `body.dry_run ?? false`, so a misspelling is stripped and the action
 * runs for real against whatever the filter matched. The caller asked for
 * a rehearsal, is answered `202`, and the job is queued. That is why
 * `refuseUnknownBodyKeys` exists beside the filter one rather than
 * instead of it: they are two different silences on one request.
 *
 * The query string has the same rule on every door, installed once by
 * `createOpenAPIRouter`; see `middleware/undeclared-query-keys.ts`.
 *
 * ## Why the declared set is derived rather than listed
 *
 * A hand-written allow-list beside a schema is two declarations of one
 * thing, which is the defect this codebase keeps finding: the schema
 * gains a parameter, the list does not, and a valid parameter starts
 * answering 400. Reading the shape off the schema cannot drift.
 */
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { RESERVED_CLIENT_PREFIX } from "../middleware/undeclared-query-keys.js";

/**
 * What these refusals need from a schema: the names it declares.
 *
 * Structural rather than `z.ZodObject<z.ZodRawShape>` because a Zod object
 * is invariant in its own shape generic, so a route's concrete schema is
 * not assignable to the general one and every call site would need a cast.
 * A cast written to satisfy a parameter that only ever reads key names is
 * a claim about the value that nothing here relies on.
 */
export interface DeclaresKeys {
  readonly shape: Readonly<Record<string, unknown>>;
}

/** The parameter names a schema declares. */
function declaredKeys(schema: DeclaresKeys): string[] {
  return Object.keys(schema.shape);
}

/**
 * The keys an object carries that its schema does not declare.
 *
 * A non-object is left alone: the schema is what has an opinion about the
 * shape, and answering "unknown fields" for an array would be answering a
 * different question than the one the caller got wrong.
 */
function undeclaredKeys(value: unknown, schema: DeclaresKeys): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const allowedSet = new Set(declaredKeys(schema));
  return Object.keys(value).filter(
    (k) => !allowedSet.has(k) && !k.startsWith(RESERVED_CLIENT_PREFIX),
  );
}

/**
 * Refuse any field the bulk-action filter does not declare.
 *
 * Unconditional, and settled separately from whatever the read doors do,
 * because this is the door where a dropped key costs rows rather than a
 * wrong answer. Checked against the parsed body before validation strips
 * it, for the same reason as above. A non-object filter is left alone —
 * the schema is what has an opinion about the shape.
 */
export function refuseUnknownFilterKeys(
  filter: unknown,
  schema: DeclaresKeys,
): void {
  const unknown = undeclaredKeys(filter, schema);
  if (unknown.length === 0) return;
  const names = unknown.map((k) => `"${k}"`).join(", ");
  const noun = unknown.length === 1 ? "field" : "fields";
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Unknown filter ${noun} ${names}. The bulk-action filter accepts: ${declaredKeys(
      schema,
    )
      .sort()
      .join(", ")}. A dropped filter field is not a narrower match set, it ` +
      `is every item, so this is refused rather than ignored.`,
    { unknown_filter_fields: unknown },
  );
}

/**
 * Refuse any key the request body itself does not declare.
 *
 * The filter refusal above covers the match set; this covers the envelope
 * around it, and that is the half that turns a rehearsal into a write.
 * `dry_run` is read as `body.dry_run ?? false`, so a misspelling is
 * stripped by the validator and the action runs for real against whatever
 * the filter matched — answering `202` and queueing the job, which is
 * indistinguishable to the caller from the dry run they asked for.
 * `max_items` is the same shape with the cap in place of the rehearsal.
 *
 * `schema` is the variant the request's `action` selected rather than the
 * whole union, so a field belonging to a different action is refused too:
 * a caller who sends `state` alongside `update_tags` believes they asked
 * for two things and is getting one.
 */
export function refuseUnknownBodyKeys(
  body: unknown,
  schema: DeclaresKeys,
): void {
  const unknown = undeclaredKeys(body, schema);
  if (unknown.length === 0) return;
  const names = unknown.map((k) => `"${k}"`).join(", ");
  const noun = unknown.length === 1 ? "field" : "fields";
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Unknown request ${noun} ${names}. This action accepts: ${declaredKeys(
      schema,
    )
      .sort()
      .join(", ")}. A dropped field is not an option left at its default — ` +
      `a stripped "dry_run" is the action running for real — so this is ` +
      `refused rather than ignored. A field of your own must start with ` +
      `"${RESERVED_CLIENT_PREFIX}", which is always ignored.`,
    { unknown_body_fields: unknown },
  );
}
