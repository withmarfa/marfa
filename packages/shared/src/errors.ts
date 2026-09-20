import type { ErrorResponse } from "./types.js";

/** All error codes used across the Marfa API. */
export enum ErrorCode {
  NOT_FOUND = "not_found",
  ITEM_NOT_FOUND = "item_not_found",
  BLOB_NOT_FOUND = "blob_not_found",
  VALIDATION_ERROR = "validation_error",
  MISSING_REQUIRED_FIELD = "missing_required_field",
  /**
   * A create / upsert named a type identifier that is well-formed but not
   * registered — a lookup answer, distinct from `TYPE_NOT_FOUND` (a
   * `/types/:id` miss) and from `TYPE_NOT_PERMITTED` (the caller may not
   * reach this type here, which is decided without a lookup). An unregistered type has no schema to
   * validate against, so the write is rejected rather than persisting an
   * unvalidated, typo-prone item. Register the type via `POST /types` first.
   *
   * A **malformed** identifier is neither: it never reached a lookup, so it
   * answers the generic `VALIDATION_ERROR` with the field named.
   */
  UNKNOWN_TYPE = "unknown_type",
  INVALID_ID = "invalid_id",
  VERSION_CONFLICT = "version_conflict",
  /**
   * The write was based on a version whose snapshot has been thinned away,
   * so there is no common ancestor to merge against.
   *
   * Its own code rather than a `version_conflict` with an empty ancestor.
   * Both refuse the write, but only one of them can be resolved: a client
   * reading the conflict envelope sees every submitted field named as
   * colliding — because nothing is known to have not collided — and under a
   * keep-both policy that resolves into a sibling holding text the person
   * never typed. Naming the state instead lets a caller park the write for
   * review rather than resolve it wrongly, and is why this is never
   * auto-merged whatever the request asked for.
   */
  ANCESTOR_UNAVAILABLE = "ancestor_unavailable",
  UNAUTHORIZED = "unauthorized",
  FORBIDDEN = "forbidden",
  /**
   * The row is a connector's copy of an external record; only the
   * owning connector writes it. Promote it to edit your own copy.
   */
  CONNECTOR_OWNED = "connector_owned",
  TYPE_NOT_PERMITTED = "type_not_permitted",
  /**
   * A credential that cannot read everything stored attempted an operation
   * only a credential reaching all of it may perform.
   *
   * Distinct from the generic `FORBIDDEN` it shares a status with, because
   * holding more permissions will not help: what the caller may
   * administer and what it may read are separate axes, and this is a refusal
   * on the second one. Outbound webhooks are the case this exists for — a
   * subscription is instance-wide and carries no credential of its own, so
   * anything it delivers is bounded by what is stored rather than by the
   * reach of whoever registered it.
   */
  SCOPED_CREDENTIAL_NOT_PERMITTED = "scoped_credential_not_permitted",
  INVALID_TRANSITION = "invalid_transition",
  TYPE_NOT_FOUND = "type_not_found",
  DUPLICATE_SOURCE = "duplicate_source",
  INVALID_GRANT = "invalid_grant",
  INVALID_CLIENT = "invalid_client",
  INVALID_SCOPE = "invalid_scope",
  /**
   * The request itself is malformed in a way that is not a body-shape
   * failure, which is what `VALIDATION_ERROR` is for. Spelled as RFC 6749
   * section 5.2 spells it; the OAuth doors answer that flat RFC shape
   * directly, and this is the same word for the call sites that answer the
   * envelope.
   */
  INVALID_REQUEST = "invalid_request",
  EXPIRED_TOKEN = "expired_token",
  TOKEN_REUSE_DETECTED = "token_reuse_detected",
  RATE_LIMITED = "rate_limited",
  CONFLICT = "conflict",
  TYPE_ALREADY_EXISTS = "type_already_exists",
  TYPE_IN_USE = "type_in_use",
  /**
   * A type cannot be deleted while another type declares it as a parent.
   * Details carry `subtype_ids`.
   *
   * Distinct from `TYPE_IN_USE`, which is about items and can be forced
   * past. This one cannot: the remedy is to delete the subtype or point it
   * at a different parent, and a caller told `type_in_use` would reasonably
   * retry with `force` and meet the same refusal.
   */
  TYPE_HAS_SUBTYPES = "type_has_subtypes",
  /**
   * A type's stored inheritance chain cannot be resolved: it is circular, or
   * deeper than any resolution walk will follow. Details carry `type_id`.
   *
   * The caller did nothing wrong, which is why this is not a 400. Every
   * write path refuses to produce such a chain, so meeting one means the
   * registry already held it. It is coded rather than bare so the type can
   * still be corrected through `PUT /types/{id}`, which reads the stored
   * schema directly and never walks the chain.
   */
  TYPE_CHAIN_UNRESOLVABLE = "type_chain_unresolvable",
  CORE_TYPE_IMMUTABLE = "core_type_immutable",
  WEBHOOK_NOT_FOUND = "webhook_not_found",
  /** No key row carries this id. */
  API_KEY_NOT_FOUND = "api_key_not_found",
  /** No grant row carries this id. */
  OAUTH_GRANT_NOT_FOUND = "oauth_grant_not_found",
  /**
   * The instance already has an owner, so `POST /owner` has nothing to
   * create. `GET /owner` says who.
   */
  OWNER_EXISTS = "owner_exists",
  /** The instance has no owner yet; `POST /owner` creates one. */
  OWNER_NOT_FOUND = "owner_not_found",
  BLOB_TOO_LARGE = "blob_too_large",
  /**
   * The request body exceeded the global JSON-write size cap
   * (`MARFA_MAX_REQUEST_BYTES`, default 1 MB). Distinct from
   * `BLOB_TOO_LARGE`, the much larger blob-upload-specific cap
   * (`MAX_BLOB_SIZE`, default 50 MB) enforced inside the blob / avatar
   * handlers — those routes are deliberately exempt from this global cap.
   * Both surface as HTTP 413; the code distinguishes which limit fired.
   */
  REQUEST_TOO_LARGE = "request_too_large",
  INVALID_PROPERTIES = "invalid_properties",
  INVALID_SCHEMA = "invalid_schema",
  /**
   * A child type registration redeclares a field that is already defined
   * by an ancestor in its parent chain. Inherited fields keep their
   * parent-type meaning in every descendant; redefining breaks the
   * generic-reader contract. See `validateTypeSchema`.
   */
  INHERITANCE_VIOLATION = "inheritance_violation",
  /**
   * A type registration declared a `fields.<name>` whose key collides
   * with a first-class field on the `Item` wire shape (e.g. `device`,
   * `source_id`, `occurred_at`, `version`, `schema_version`,
   * `capture_latitude`, `capture_longitude`). Letting a custom type
   * redefine a first-class field name means every row carries two
   * values under the same name and nothing downstream can tell which is
   * authoritative. Reject at registration so the type author renames
   * before any data is written. Authoritative list lives at
   * `RESERVED_ITEM_FIELDS` in `type-registry.ts`, derived from the
   * `Item` interface in `types.ts`.
   */
  PROPERTY_SHADOWS_FIELD = "property_shadows_field",
  /**
   * At type registration, the submitted version does not match the diff
   * class against the existing schema — e.g. removing a field while
   * submitting a patch version, or re-submitting an identical schema
   * (no-op).
   */
  VERSION_BUMP_MISMATCH = "version_bump_mismatch",
  /**
   * A `compatible_with` declaration does not satisfy the structural-superset
   * rule: every required field on the target type must be present with a
   * matching shape.
   */
  COMPATIBLE_WITH_VIOLATION = "compatible_with_violation",
  // ---------------------------------------------------------------------
  // Edge error codes
  // ---------------------------------------------------------------------
  /** Edge creation / update violated cardinality or type constraints. */
  EDGE_CONSTRAINT_VIOLATION = "edge_constraint_violation",
  /**
   * An edge creation would close a cycle: a self-loop on any edge type, or a
   * longer cycle on `parent-of` or `supersedes`, the two whose graphs are not
   * acyclic by construction.
   */
  EDGE_CYCLE = "edge_cycle",
  /** The referenced edge_type is not in the core or custom registry. */
  EDGE_TYPE_NOT_FOUND = "edge_type_not_found",
  /** The caller lacks the required edge-type permission for this verb. */
  EDGE_PERMISSION_DENIED = "edge_permission_denied",
  /** The referenced edge id does not exist. */
  EDGE_NOT_FOUND = "edge_not_found",
  // ---------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------
  /** A destructive bulk action was called without the required `confirm` literal. */
  BULK_CONFIRMATION_REQUIRED = "bulk_confirmation_required",
  /** A bulk action matched more items than `max_items` permits. */
  BULK_CAP_EXCEEDED = "bulk_cap_exceeded",
  /** An atomic bulk upsert failed on one item and rolled back the whole batch. */
  BULK_ATOMIC_ROLLBACK = "bulk_atomic_rollback",
  /**
   * A referenced bulk-action job id does not exist or is not visible to
   * the caller. Returned by `GET /items/bulk-actions/jobs/:id` and
   * `DELETE /items/bulk-actions/jobs/:id`. Cancelled / failed terminal
   * states are NOT in this enum — they're carried in the job envelope's
   * `status` field on a 200 GET, and SDKs classify them client-side
   * rather than the server returning an HTTP error.
   */
  BULK_JOB_NOT_FOUND = "bulk_job_not_found",
  /**
   * Every streaming connection slot is in use and none freed within the
   * reservation window. Retryable by definition: streams end and slots
   * free, so a client seeing this backs off and asks again.
   */
  STREAM_CAPACITY_EXHAUSTED = "stream_capacity_exhausted",
  /**
   * `PATCH /items/:id` was called with a `source_id` that already belongs
   * to a different item under the caller's stamped `source`. The natural-key
   * uniqueness invariant `(source, source_id)` matches the create-time
   * constraint — re-pointing an item at an in-use natural key would create
   * two rows with the same lookup tuple, breaking the create-or-update
   * contract that downstream importers and the sync agent rely on. Rejected
   * pre-write so no partial state lands. PATCHing the same `source_id` the
   * item already carries is a no-op success, not a conflict.
   */
  SOURCE_ID_CONFLICT = "source_id_conflict",
  /**
   * A write resolved an existing row whose type is not the one the request
   * declared. The write is refused rather than reinterpreted.
   *
   * Every door that addresses a row by something other than its type,
   * `(source, source_id)` on `POST /items` and `POST /items/bulk` and an id
   * on `PATCH /items/{id}` and on the bulk path, would otherwise take the
   * resolved row's type and merge the submitted properties onto it: a
   * caller declaring one type and landing on another would get a 200 and a
   * row of the other shape. That is silent, and it is reachable from both
   * directions: a mapping added re-types on the way in, a mapping removed
   * re-types on the way back.
   *
   * 409 rather than 400: the request is well-formed, and it is the state
   * of the stored row that makes it impossible. Moving a corpus between
   * types is a deliberate operation rather than a side effect of a sync.
   */
  TYPE_MISMATCH = "type_mismatch",
  /**
   * An `Idempotency-Key` names a request that is still being served.
   *
   * The record is claimed by an INSERT against a unique index, so exactly
   * one of two simultaneous arrivals holds it and the other is told this
   * rather than being allowed to write. Retrying is the right response,
   * and the claim carries a lease so a writer that dies mid-request
   * cannot hold the key past it.
   */
  IDEMPOTENCY_KEY_IN_FLIGHT = "idempotency_key_in_flight",
  /**
   * An `Idempotency-Key` was replayed with a different request.
   *
   * A key stands for one request, so serving the stored result here would
   * silently discard a write the caller believes it made — the failure the
   * key exists to prevent, arriving from the other direction. Refusing
   * names the defect at the caller instead. The comparison covers the
   * method, the path, the query, the body and the credential.
   */
  IDEMPOTENCY_KEY_REUSED = "idempotency_key_reused",
  /**
   * A repeat resolved a record whose response body was not retained.
   *
   * A response above the retention bound is recorded without its body, so
   * the repeat still performs no second write and still learns the status
   * the first attempt returned — in `details.original_status` — but cannot
   * be handed the original response. `422` rather than `409`: nothing got
   * there first, so a client branching on `409` as a conflict must not
   * catch it.
   */
  IDEMPOTENCY_RESULT_NOT_RETAINED = "idempotency_result_not_retained",
}

/** Maps each error code to its HTTP status code. */
const STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ITEM_NOT_FOUND]: 404,
  [ErrorCode.BLOB_NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.UNKNOWN_TYPE]: 400,
  [ErrorCode.INVALID_ID]: 400,
  [ErrorCode.VERSION_CONFLICT]: 409,
  [ErrorCode.ANCESTOR_UNAVAILABLE]: 409,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.CONNECTOR_OWNED]: 403,
  [ErrorCode.TYPE_NOT_PERMITTED]: 403,
  [ErrorCode.SCOPED_CREDENTIAL_NOT_PERMITTED]: 403,
  [ErrorCode.INVALID_TRANSITION]: 400,
  [ErrorCode.TYPE_NOT_FOUND]: 404,
  [ErrorCode.DUPLICATE_SOURCE]: 409,
  [ErrorCode.INVALID_GRANT]: 400,
  [ErrorCode.INVALID_CLIENT]: 400,
  [ErrorCode.INVALID_SCOPE]: 400,
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.EXPIRED_TOKEN]: 401,
  [ErrorCode.TOKEN_REUSE_DETECTED]: 400,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.TYPE_ALREADY_EXISTS]: 409,
  [ErrorCode.TYPE_IN_USE]: 409,
  [ErrorCode.TYPE_HAS_SUBTYPES]: 409,
  [ErrorCode.TYPE_CHAIN_UNRESOLVABLE]: 409,
  [ErrorCode.CORE_TYPE_IMMUTABLE]: 403,
  [ErrorCode.WEBHOOK_NOT_FOUND]: 404,
  [ErrorCode.API_KEY_NOT_FOUND]: 404,
  [ErrorCode.OAUTH_GRANT_NOT_FOUND]: 404,
  [ErrorCode.OWNER_EXISTS]: 409,
  [ErrorCode.OWNER_NOT_FOUND]: 404,
  [ErrorCode.VERSION_BUMP_MISMATCH]: 422,
  [ErrorCode.COMPATIBLE_WITH_VIOLATION]: 422,
  [ErrorCode.BLOB_TOO_LARGE]: 413,
  [ErrorCode.REQUEST_TOO_LARGE]: 413,
  [ErrorCode.INVALID_PROPERTIES]: 400,
  [ErrorCode.INVALID_SCHEMA]: 400,
  [ErrorCode.INHERITANCE_VIOLATION]: 400,
  [ErrorCode.PROPERTY_SHADOWS_FIELD]: 400,
  [ErrorCode.EDGE_CONSTRAINT_VIOLATION]: 400,
  [ErrorCode.EDGE_CYCLE]: 400,
  [ErrorCode.EDGE_TYPE_NOT_FOUND]: 404,
  [ErrorCode.EDGE_PERMISSION_DENIED]: 403,
  [ErrorCode.EDGE_NOT_FOUND]: 404,
  [ErrorCode.BULK_CONFIRMATION_REQUIRED]: 400,
  [ErrorCode.BULK_CAP_EXCEEDED]: 400,
  [ErrorCode.BULK_ATOMIC_ROLLBACK]: 400,
  [ErrorCode.BULK_JOB_NOT_FOUND]: 404,
  [ErrorCode.STREAM_CAPACITY_EXHAUSTED]: 503,
  [ErrorCode.SOURCE_ID_CONFLICT]: 409,
  [ErrorCode.TYPE_MISMATCH]: 409,
  // A genuine 409: the key is held by a request in flight, or contention
  // kept it changing hands. Something else got there first, which is
  // exactly what a client branching on 409 expects to mean.
  [ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT]: 409,
  // 422 rather than 409: the request is refused because of what the caller
  // sent, not because of what the server holds, and a client branching on
  // 409 to mean "somebody else got there first" must not catch this.
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 422,
  // 422 for the same reason. Nothing got there first: the record exists,
  // the write is not repeated, and the only thing missing is the body, so a
  // client that reads 409 as a conflict would act on this exactly wrongly.
  [ErrorCode.IDEMPOTENCY_RESULT_NOT_RETAINED]: 422,
};

/** Returns the HTTP status code for a given error code. */
export function httpStatus(code: ErrorCode): number {
  return STATUS_MAP[code];
}

/** Structured error thrown by the server and SDK. Carries a typed code and HTTP status. */
export class MarfaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MarfaError";
    this.code = code;
    this.status = STATUS_MAP[code];
    this.details = details;
  }

  toResponse(): ErrorResponse {
    const response: ErrorResponse = {
      error: {
        code: this.code,
        message: this.message,
      },
    };
    if (this.details) {
      response.error.details = this.details;
    }
    return response;
  }
}

/**
 * A type identifier the grammar refused, which never reached a lookup.
 *
 * `unknown_type` is a lookup answer and `type_not_permitted` is a permission
 * one, so neither fits a string that is not a type identifier at all. That
 * leaves the generic validation refusal, and the point of routing it through
 * one function is the shape: `details.errors[].path` is what the router's own
 * schema failures carry, so a caller reads one envelope whether the grammar
 * was checked by a zod schema or by hand.
 *
 * `context` carries whatever else a producer wants in `details` and is closed
 * over `errors`, which this function owns. Accepting one and overwriting it
 * would drop a caller's own list without saying so, and accepting one and
 * keeping it would put back the second envelope this exists to remove.
 */
export function malformedTypeIdentifier(
  path: string,
  message: string,
  context?: Record<string, unknown> & { errors?: never },
): MarfaError {
  return new MarfaError(ErrorCode.VALIDATION_ERROR, message, {
    ...context,
    errors: [{ path, message }],
  });
}
