import {
  ErrorCode,
  GLOBAL_TYPE_WILDCARD,
  MarfaError,
  getTypeSchema,
  isValidTypePattern,
  malformedTypeIdentifier,
} from "@withmarfa/shared";

/**
 * Validate the `type` filter the list surfaces share: `GET /items`,
 * `GET /search` and `GET /export` all read it as "this type and everything
 * under it", so it is validated once, here, and each route calls this.
 *
 * Two refusals, and they answer different questions. A value outside the
 * pattern grammar, or the global `*`, is not a filter at all: the value
 * compiles into a `LIKE` predicate, so it has to clear the grammar rather
 * than a shape check, and "everything" is a read with no filter, which
 * would otherwise slip past the per-type enforcement levers keyed off this
 * parameter. That is `validation_error`, as it always was.
 *
 * **A concrete identifier that names no registered type is `unknown_type`.**
 * It used to answer an empty page, and an empty page is the one answer a
 * client cannot tell from a quiet instance: a typo in a type
 * name, a type registered under another handle, and a type deleted since
 * the client last hydrated all read as "no items here", so the client
 * carries on believing a filter it is not actually applying. A wildcard is
 * different in kind: `acme.*` names whatever is under `acme` today, which
 * may be nothing, and nothing is a correct answer to it. And a registered
 * type the credential cannot read is not this refusal's business: the
 * listing and the export keep answering an empty page for it, because the
 * scope list on the token response is the client's signal for that, and
 * refusing would tell a caller which types exist beyond its grant. Search
 * already answers 403 there through `requireTypeAccess`, a permission
 * answer about a type the caller named, and keeps doing so.
 *
 * Resolved through the registry, exactly as it is for a write.
 * That includes a type removed with `DELETE /types/{id}?force=true`: the
 * rows it kept stay reachable by id and under a wildcard, and a listing
 * that names a type nobody has registered is the case this exists to
 * refuse, until the type is registered again.
 */
export function assertTypeFilter(type: string | undefined): void {
  if (!type) return;
  if (type === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(type)) {
    // Every caller reads it from a `type` query parameter.
    throw malformedTypeIdentifier("type", `Invalid type identifier: ${type}`);
  }
  if (type.endsWith(".*")) return;
  if (getTypeSchema(type) === undefined) {
    throw new MarfaError(ErrorCode.UNKNOWN_TYPE, `Unknown type: ${type}`);
  }
}
