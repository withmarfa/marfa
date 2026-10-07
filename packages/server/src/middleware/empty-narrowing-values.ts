/**
 * Refusing a narrowing parameter sent with no value.
 *
 * `type`, `source`, `tags` and `filter` each narrow what a door answers.
 * Sent empty, the validator hands the door an empty string, and a door that
 * reads it as "no filter" answers the whole listing. A client that built the
 * query from a variable it never filled in reads everything while believing
 * it narrowed: the failure the refusal of an undeclared key removes, reached
 * through a key the door does declare. Read from the raw query string, as
 * that refusal is, so every door that declares one of these keys refuses it
 * the same way and a door added later does not have to remember.
 *
 * A value that holds only blanks narrows nothing either, and so does a list
 * whose every entry is blank, as `type=,` and `tags=, ` are: a door that
 * trims and drops empty entries is left with no filter. `tags`, and `type` on
 * `GET /events`, are comma lists; elsewhere `type` is one pattern, and
 * `source` and `filter` are single values.
 *
 * An edge shorthand such as `edge[<type>]=` is refused where it is read,
 * because its key carries the edge type and no schema lists it.
 *
 * `POST /items/bulk-actions` takes the same four as fields of its `filter`
 * and is refused the same way (`refuseEmptyNarrowingFilter`), with each
 * field named by its path. Its `tags` is an array, so an empty array and an
 * array of blank entries narrow nothing too.
 */
import type { MiddlewareHandler } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";

/** The query keys that narrow a door's answer and have no meaning when empty. */
export const NARROWING_KEYS: readonly string[] = [
  "type",
  "source",
  "tags",
  "filter",
];

/** The keys whose value is a comma-separated list. */
const LIST_KEYS: readonly string[] = ["type", "tags"];

/** Whether a value, read as the door reads it, holds nothing to narrow by. */
function narrowsNothing(
  key: string,
  value: string,
  listed = LIST_KEYS.includes(key),
): boolean {
  const entries = listed ? value.split(",") : [value];
  return entries.every((entry) => entry.trim() === "");
}

/**
 * Refuse any narrowing key of `url` that `declared` lists and whose value
 * narrows nothing, in one `400 validation_error` naming them in
 * `details.empty_parameters`.
 */
export function refuseEmptyNarrowingValuesOf(
  url: string,
  declared: readonly string[],
): void {
  const empty: string[] = [];
  for (const [key, value] of new URL(url).searchParams.entries()) {
    if (!NARROWING_KEYS.includes(key) || !declared.includes(key)) continue;
    if (!narrowsNothing(key, value)) continue;
    if (!empty.includes(key)) empty.push(key);
  }
  if (empty.length === 0) return;
  const names = empty.map((key) => `"${key}"`).join(", ");
  const noun = empty.length === 1 ? "filter was" : "filters were";
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `The ${names} ${noun} sent with nothing to narrow by. A filter with no value narrows nothing and would return everything the endpoint can read. Send a value, or leave the parameter out.`,
    { empty_parameters: empty },
  );
}

/**
 * Refuse a bulk action's `filter` that holds a narrowing field narrowing
 * nothing, in one `400 validation_error` naming each as `filter.<field>` in
 * `details.empty_parameters`. A field left out is no filter on that axis and
 * is not refused: only one sent with nothing in it is.
 */
export function refuseEmptyNarrowingFilter(
  filter: Partial<Record<string, unknown>>,
): void {
  const empty: string[] = [];
  for (const key of NARROWING_KEYS) {
    const value = filter[key];
    if (value === undefined) continue;
    const narrows = Array.isArray(value)
      ? value.some((entry) => String(entry).trim() !== "")
      : typeof value === "string" && !narrowsNothing(key, value, false);
    if (!narrows) empty.push(`filter.${key}`);
  }
  if (empty.length === 0) return;
  const names = empty.map((key) => `"${key}"`).join(", ");
  const noun = empty.length === 1 ? "filter was" : "filters were";
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `The ${names} ${noun} sent with nothing to narrow by. A filter with no value narrows nothing and would match everything the action may write. Send a value, or leave the field out.`,
    { empty_parameters: empty },
  );
}

/** The same refusal, as middleware for a door that declares `declared`. */
export function refuseEmptyNarrowingValues(
  declared: readonly string[],
): MiddlewareHandler {
  return async (c, next) => {
    refuseEmptyNarrowingValuesOf(c.req.url, declared);
    await next();
  };
}
