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
 * An edge shorthand such as `edge[<type>]=` is refused where it is read,
 * because its key carries the edge type and no schema lists it.
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

/**
 * Refuse any narrowing key of `url` that `declared` lists and that holds an
 * empty value, in one `400 validation_error` naming them in
 * `details.empty_parameters`.
 */
export function refuseEmptyNarrowingValuesOf(
  url: string,
  declared: readonly string[],
): void {
  const empty: string[] = [];
  for (const [key, value] of new URL(url).searchParams.entries()) {
    if (value !== "") continue;
    if (!NARROWING_KEYS.includes(key) || !declared.includes(key)) continue;
    if (!empty.includes(key)) empty.push(key);
  }
  if (empty.length === 0) return;
  const names = empty.map((key) => `"${key}"`).join(", ");
  const noun = empty.length === 1 ? "filter was" : "filters were";
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `The ${names} ${noun} sent with no value. An empty filter narrows nothing and would return everything the endpoint can read. Send a value, or leave the parameter out.`,
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
