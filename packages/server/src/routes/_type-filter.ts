import {
  ErrorCode,
  GLOBAL_TYPE_WILDCARD,
  MarfaError,
  getTypeSchema,
  isValidTypePattern,
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
 * **A concrete identifier that names no type the caller's space can see is
 * `unknown_type`.** It used to answer an empty page, and an empty page is
 * the one answer a client cannot tell from a quiet space: a typo in a type
 * name, a type registered under another handle, and a type deleted since
 * the client last hydrated all read as "no items here", so the client
 * carries on believing a filter it is not actually applying. A wildcard is
 * different in kind: `acme.*` names whatever is under `acme` today, which
 * may be nothing, and nothing is a correct answer to it. And a registered
 * type the credential cannot read still answers an empty page, because the
 * scope list on the token response is the client's signal for that, and
 * refusing would tell a caller which types exist beyond its grant.
 *
 * Resolved in the caller's space, so a custom type registered in one space
 * is unknown in another, exactly as the registry resolves it for a write.
 */
export function assertTypeFilter(
  type: string | undefined,
  spaceId: string | undefined,
): void {
  if (!type) return;
  if (type === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(type)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid type identifier");
  }
  if (type.endsWith(".*")) return;
  if (getTypeSchema(type, spaceId) === undefined) {
    throw new MarfaError(ErrorCode.UNKNOWN_TYPE, `Unknown type: ${type}`);
  }
}
