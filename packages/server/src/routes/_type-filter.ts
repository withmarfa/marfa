import type { Context } from "hono";
import {
  ErrorCode,
  GLOBAL_TYPE_WILDCARD,
  MarfaError,
  getTypeSchema,
  isSubtypeOf,
  isValidTypePattern,
  listTypes,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import {
  checkAuth,
  mayReadType,
  requireTypeAccess,
  type AppEnv,
} from "../middleware/auth.js";

/**
 * Validate the `type` filter the list surfaces share: `GET /items`,
 * `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences` and
 * each entry of `GET /events`'s list all read it as "this type and everything
 * under it", so it is validated once, here, and each route calls this.
 *
 * Three refusals, and they answer different questions. A value outside the
 * pattern grammar, or the global `*`, is not a filter at all: the value
 * compiles into a `LIKE` predicate, so it has to clear the grammar rather
 * than a shape check, and "everything" is a read with no filter, which
 * would otherwise slip past the per-type enforcement levers keyed off this
 * parameter. That is `validation_error`, as it always was.
 *
 * **A concrete identifier that names no registered type is `unknown_type`.**
 * An empty page is the one answer a client cannot tell from a quiet instance:
 * a typo in a type name, a type registered under another handle, and a type
 * deleted since the client last hydrated all read as "no items here", so the
 * client carries on believing a filter it is not applying. A wildcard is
 * different in kind: `acme.*` names whatever is under `acme` today, which
 * may be nothing, and nothing is a correct answer to it.
 *
 * **A registered concrete type the credential may not read is
 * `type_not_permitted`, unless it reads something under it.** The caller named
 * it, so the credential is told it lacks the grant, as it is on a write. The
 * empty page it replaces said "nothing here" about a type that is plainly
 * registered, and hid nothing: the registry already tells a registered type
 * from an unregistered one, and `GET /types` lists every schema.
 *
 * **A pattern is never refused for what it reaches.** `core.*` names a set,
 * and the answer is the part of it the credential may read, an empty page
 * when that is none. The same narrowing every listing applies to its rows
 * does the work (`getTypeFilter`), so a pattern wider than the grant is a
 * listing, not a refusal. The credential that reaches no type at all is
 * refused before any filter is read.
 *
 * Resolved through the registry, exactly as it is for a write.
 * That includes a type removed with `DELETE /types/{id}?force=true`: the
 * rows it kept stay reachable by id and under a wildcard, and a listing
 * that names a type nobody has registered is the case this exists to
 * refuse, until the type is registered again.
 */
export function assertTypeFilter(
  c: Context<AppEnv>,
  type: string | undefined,
): void {
  if (!type) return;
  if (type === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(type)) {
    // Every caller reads it from a `type` query parameter.
    throw malformedTypeIdentifier("type", `Invalid type identifier: ${type}`);
  }
  if (type.endsWith(".*")) return;
  if (getTypeSchema(type) === undefined) {
    throw new MarfaError(ErrorCode.UNKNOWN_TYPE, `Unknown type: ${type}`);
  }
  assertTypeReadable(c, type);
}

/**
 * A concrete `type` filter selects the type and everything under it, so it is
 * refused only when nothing it selects is readable. A credential that reads a
 * descendant and not the named type gets the descendants, narrowed by the same
 * map every listing applies to its rows; refusing it would withhold rows it
 * is entitled to. Shared with the bulk-action filter, which selects the same
 * subtree but does not ask the registry.
 */
export function assertTypeReadable(c: Context<AppEnv>, type: string): void {
  const key = checkAuth(c.get("apiKey"));
  const reachesReadable =
    !mayReadType(key, type) &&
    listTypes().some(
      (candidate) =>
        candidate.id !== type &&
        (candidate.id.startsWith(`${type}.`) ||
          isSubtypeOf(candidate.id, type)) &&
        mayReadType(key, candidate.id),
    );
  if (reachesReadable) return;
  requireTypeAccess(c, type, "read");
}
