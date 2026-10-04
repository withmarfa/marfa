/**
 * Refusing a query key the door does not declare.
 *
 * The request validator strips a key it does not declare rather than
 * rejecting it, so a caller who misspells a filter gets a successful
 * response holding everything the filter was meant to exclude. Nothing in
 * that response separates it from a filter that matched every row: **a
 * filter that does not exist is indistinguishable from one that matched
 * everything.** Read from the raw query string, because by the time the
 * validated query exists the unknown key is already gone from it.
 *
 * `createOpenAPIRouter` installs this on every route it registers, behind
 * the route's credential gate and its own standing rule, so a bare request
 * answers `401` and a credential that may not use the door answers `403`
 * whatever its query says. The declared set is read off the route's own
 * query schema, so a parameter added to a schema is accepted at once and
 * there is no second list to keep in step.
 *
 * A door with no query schema takes no query: every key is refused.
 *
 * ## The escape hatch
 *
 * A client appending a parameter of its own, such as a cache-buster, would
 * see a working request become a `400`, so a key starting with
 * {@link RESERVED_CLIENT_PREFIX} is ignored by contract. No door declares a
 * parameter starting with `_`, and a misspelling of a real one never does
 * either, so the hatch does not weaken the catch.
 *
 * ## Keys that no schema can list
 *
 * `GET /items` takes `edge[<type>]` and `backref[<type>]`, where the type
 * is part of the key. A route that takes keys like that says so beside its
 * definition with {@link takesQueryKeysLike}, and only that route does.
 */
import type { MiddlewareHandler } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";

/**
 * Keys under this prefix are the client's own and are never refused.
 *
 * Documented rather than incidental: a caller needs a spelling that is
 * guaranteed to be ignored, and "whatever the server happens not to
 * validate" is not that guarantee.
 */
export const RESERVED_CLIENT_PREFIX = "_";

/** A family of query keys no schema can enumerate. */
export interface QueryKeyFamily {
  /** Matches every key in the family. */
  pattern: RegExp;
  /** How the family reads in a refusal, such as `edge[<type>]`. */
  spelling: string;
}

const families = new WeakMap<object, readonly QueryKeyFamily[]>();

/**
 * Say, beside a route, that it also takes the keys of these families.
 *
 * Returns the route it was given, so it reads as part of the definition:
 * `const route = takesQueryKeysLike(createRoute({...}), {...})`.
 */
export function takesQueryKeysLike<R extends object>(
  route: R,
  ...declared: QueryKeyFamily[]
): R {
  families.set(route, declared);
  return route;
}

/** The families a route declared with {@link takesQueryKeysLike}. */
export function queryKeyFamilies(route: object): readonly QueryKeyFamily[] {
  return families.get(route) ?? [];
}

/**
 * The names a query schema declares.
 *
 * A schema that is not an object has no names to read, and treating it as
 * declaring none would refuse every key on a door that takes some, so it
 * throws when the route is registered instead.
 */
export function declaredQueryKeys(schema: unknown): string[] {
  if (schema === undefined) return [];
  const shape: unknown =
    typeof schema === "object" && schema !== null && "shape" in schema
      ? schema.shape
      : undefined;
  if (typeof shape !== "object" || shape === null) {
    throw new Error(
      "A route's query schema must be an object schema, so that the keys it declares can be read",
    );
  }
  return Object.keys(shape);
}

/**
 * The query parameters a hand-written OpenAPI operation documents, for a
 * door that is not a `createRoute` route and so has no schema to read.
 */
export function documentedQueryKeys(operation: unknown): string[] {
  const parameters = (operation as { parameters?: unknown } | null)?.parameters;
  if (!Array.isArray(parameters)) return [];
  return parameters.flatMap((parameter: { name?: unknown; in?: unknown }) =>
    parameter.in === "query" && typeof parameter.name === "string"
      ? [parameter.name]
      : [],
  );
}

function refusal(
  unknown: string[],
  declared: readonly string[],
  familySpellings: readonly string[],
): MarfaError {
  const names = unknown.map((k) => `"${k}"`).join(", ");
  const noun = unknown.length === 1 ? "parameter" : "parameters";
  const accepted = [...declared].sort().concat(familySpellings);
  const accepts =
    accepted.length === 0
      ? "This endpoint takes no query parameters."
      : `This endpoint accepts: ${accepted.join(", ")}.`;
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Unknown query ${noun} ${names}. ${accepts} A parameter of your own must start with ` +
      `"${RESERVED_CLIENT_PREFIX}", which is always ignored.`,
    { unknown_parameters: unknown },
  );
}

/**
 * Refuse any query key of `url` outside `declared`, the reserved prefix and
 * the `allowed` families, in one `400 validation_error` naming them in
 * `details.unknown_parameters`.
 */
export function refuseUndeclaredKeysOf(
  url: string,
  declared: readonly string[],
  allowed: readonly QueryKeyFamily[] = [],
): void {
  const unknown: string[] = [];
  for (const key of new URL(url).searchParams.keys()) {
    if (declared.includes(key)) continue;
    if (key.startsWith(RESERVED_CLIENT_PREFIX)) continue;
    if (allowed.some((family) => family.pattern.test(key))) continue;
    // A repeated unknown key is one mistake, not several.
    if (!unknown.includes(key)) unknown.push(key);
  }
  if (unknown.length > 0) {
    throw refusal(
      unknown,
      declared,
      allowed.map((family) => family.spelling),
    );
  }
}

/** The same refusal, as middleware for a door that declares `declared`. */
export function refuseUndeclaredQueryKeys(
  declared: readonly string[],
  allowed: readonly QueryKeyFamily[] = [],
): MiddlewareHandler {
  return async (c, next) => {
    refuseUndeclaredKeysOf(c.req.url, declared, allowed);
    await next();
  };
}
