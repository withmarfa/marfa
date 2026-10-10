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
  READ_VIEW_CHANGED = "read_view_changed",
  /**
   * The write was based on a version with no snapshot it may be merged
   * against: none is held (never issued, or thinned away), or the one held
   * is of a type the writer may not read. Either way there is no common
   * ancestor to merge against, and the two answer alike.
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
  TYPE_NOT_PERMITTED = "type_not_permitted",
  INVALID_TRANSITION = "invalid_transition",
  TYPE_NOT_FOUND = "type_not_found",
  INVALID_CLIENT = "invalid_client",
  RATE_LIMITED = "rate_limited",
  CONFLICT = "conflict",
  TYPE_ALREADY_EXISTS = "type_already_exists",
  TYPE_IN_USE = "type_in_use",
  /**
   * `DELETE /edge-types/{id}` with edges of the type still stored.
   * `?force=true` deletes anyway and leaves those edges naming a type
   * the instance no longer holds.
   *
   * Its own code rather than `TYPE_IN_USE`, matching the
   * `EDGE_TYPE_NOT_FOUND` that already sits beside `TYPE_NOT_FOUND`: the
   * two doors should agree in shape, which they now do, and an edge
   * type is not a type. A caller branching on the code can tell which
   * registry refused it without reading the message.
   */
  EDGE_TYPE_IN_USE = "edge_type_in_use",
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
  API_KEY_NOT_FOUND = "api_key_not_found",
  OAUTH_GRANT_NOT_FOUND = "oauth_grant_not_found",
  /**
   * The instance already has an owner, so `POST /owner` has nothing to
   * create. `GET /owner` says who.
   */
  OWNER_EXISTS = "owner_exists",
  OWNER_NOT_FOUND = "owner_not_found",
  /**
   * The request body exceeded the global JSON-write size cap
   * (`MARFA_MAX_REQUEST_BYTES`, default 1 MB). A blob upload is exempt from
   * that cap and has no cap of its own: its body streams to disk.
   */
  REQUEST_TOO_LARGE = "request_too_large",
  /**
   * A `Range` request on a blob asked for bytes the blob does not have. The
   * response's `Content-Range` names the blob's size so the caller can ask
   * again within bounds.
   */
  RANGE_NOT_SATISFIABLE = "range_not_satisfiable",
  INVALID_PROPERTIES = "invalid_properties",
  INVALID_SCHEMA = "invalid_schema",
  /**
   * A child type redeclares a field an ancestor defines, with another
   * shape. Inherited fields keep their parent-type meaning in every
   * descendant; reshaping one breaks the generic-reader contract. See
   * `validateTypeSchema`.
   */
  INHERITANCE_VIOLATION = "inheritance_violation",
  /**
   * A type registration declared a `fields.<name>` whose key collides
   * with a first-class field on the `Item` wire shape (e.g. `source_id`,
   * `occurred_at`, `version`, `schema_version`, `capture_latitude`,
   * `capture_longitude`). Letting a custom type redefine a first-class
   * field name means every row carries two values under the same name
   * and nothing downstream can tell which is authoritative. Reject at
   * registration so the type author renames before any data is written.
   * Authoritative list lives at
   * `RESERVED_ITEM_FIELDS` in `type-registry.ts`, derived from the
   * `Item` interface in `types.ts`.
   */
  PROPERTY_SHADOWS_FIELD = "property_shadows_field",
  /**
   * A `compatible_with` declaration does not satisfy the structural-superset
   * rule: every required field on the target type must be present with a
   * matching shape.
   */
  COMPATIBLE_WITH_VIOLATION = "compatible_with_violation",
  // ---------------------------------------------------------------------
  // Edge error codes
  // ---------------------------------------------------------------------
  EDGE_CONSTRAINT_VIOLATION = "edge_constraint_violation",
  /**
   * An edge creation would close a cycle: a self-loop on any edge type, or a
   * longer cycle on `parent-of` or `supersedes`, the two whose graphs are not
   * acyclic by construction.
   */
  EDGE_CYCLE = "edge_cycle",
  EDGE_TYPE_NOT_FOUND = "edge_type_not_found",
  EDGE_PERMISSION_DENIED = "edge_permission_denied",
  EDGE_NOT_FOUND = "edge_not_found",
  // ---------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------
  BULK_CONFIRMATION_REQUIRED = "bulk_confirmation_required",
  BULK_CAP_EXCEEDED = "bulk_cap_exceeded",
  BULK_ATOMIC_ROLLBACK = "bulk_atomic_rollback",
  /**
   * A referenced bulk-action job id does not exist or is not visible to
   * the caller. Returned by `GET /items/bulk-actions/jobs/:id` and
   * `POST /items/bulk-actions/jobs/:id/cancel`. Canceled / failed terminal
   * states are NOT in this enum — they're carried in the job envelope's
   * `status` field on a 200 GET, for a client to classify, rather than
   * the server returning an HTTP error.
   */
  BULK_JOB_NOT_FOUND = "bulk_job_not_found",
  /** `DELETE /blobs/{hash}/locations/{store}` named a store that holds no
   *  copy of the blob, or that is not attached. */
  BLOB_LOCATION_NOT_FOUND = "blob_location_not_found",
  /** Dropping the copy would leave fewer live copies than the instance's
   *  minimum; the copy stays. */
  COPIES_BELOW_MINIMUM = "copies_below_minimum",
  /** `POST /housekeeping/:name/run` named a housekeeping job this instance
   *  does not run: unregistered, or switched off by configuration. */
  HOUSEKEEPING_JOB_NOT_FOUND = "housekeeping_job_not_found",
  /** The housekeeping job is in the middle of a run, and a housekeeping job
   *  never overlaps itself. */
  HOUSEKEEPING_JOB_RUNNING = "housekeeping_job_running",
  CONNECTOR_NOT_FOUND = "connector_not_found",
  /** Another process holds the connector's registration until
   *  `details.expires_at`. */
  CONNECTOR_HELD = "connector_held",
  ENDPOINT_NOT_FOUND = "endpoint_not_found",
  DELIVERY_NOT_FOUND = "delivery_not_found",
  /**
   * An inbound endpoint cannot take a delivery now: its connector's backlog
   * is full, or the instance holds as many bodies in flight as it will.
   * Retryable: the sender records a failure it can deliver again.
   */
  INBOUND_UNAVAILABLE = "inbound_unavailable",
  REQUEST_TIMEOUT = "request_timeout",
  /**
   * Every streaming connection slot is in use and none freed within the
   * reservation window. Retryable by definition: streams end and slots
   * free, so a client seeing this backs off and asks again.
   */
  STREAM_CAPACITY_EXHAUSTED = "stream_capacity_exhausted",
  /**
   * A write met the row lock and never got it inside the instance's busy
   * budget. Transient by definition: the holder commits and the next
   * attempt succeeds, so a client retries rather than changing anything
   * about the request.
   *
   * `503` and not `409`. A conforming device retries a `5xx` without
   * counting it against the write (`queue-and-verdicts/environmental-uncounted`), while a
   * `409` with this code is refused on the first answer
   * (`queue-and-verdicts/refused-contract`). Contention is the case
   * the retry exists for, so a `409` would make every device give up on
   * a write that would have landed on the next try.
   */
  WRITE_CONTENTION = "write_contention",
  /**
   * The volume the instance writes to has no room for this write: the disk
   * is full, or the write would leave less free than the instance's
   * reserve. Nothing of the request was kept, unless the volume turned away
   * the commit itself, which `details.write_outcome` of `unknown` says.
   *
   * `507` and not `503`. A `503` here would read as the instance busy, and
   * a retry a moment later cannot help; only someone freeing space can.
   * It is still a `5xx`, so a conforming device keeps the write queued and
   * tries again rather than dropping it as refused
   * (`queue-and-verdicts/environmental-uncounted`).
   */
  INSUFFICIENT_STORAGE = "insufficient_storage",
  /**
   * `PATCH /items/:id` was called with a `source_id` that already belongs
   * to a different item under the caller's stamped `source`. The natural-key
   * uniqueness invariant `(source, source_id)` matches the create-time
   * constraint — re-pointing an item at an in-use natural key would create
   * two rows with the same lookup tuple, breaking the create-or-update
   * contract that an importer and a device's drain rely on. Rejected
   * pre-write so no partial state lands. PATCHing the same `source_id` the
   * item already carries is a no-op success, not a conflict.
   */
  SOURCE_ID_CONFLICT = "source_id_conflict",
  /** A write would give a row a link another row of its type holds. The
   *  holder is named: the caller holds write on the type both rows share. */
  LINK_TAKEN = "link_taken",
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
   * types is a deliberate operation rather than a side effect of a drain.
   */
  TYPE_MISMATCH = "type_mismatch",

  /**
   * A caller-minted id that already names something else.
   *
   * One code wherever it happens — `POST /items`, `POST /edges`, and a
   * bulk entry the id fallback resolved — because it is one mistake: a
   * client picked an id, sent it, and the id is taken by a row that is
   * not the one it is describing. A client sorts a refusal by its code,
   * and a code that depended on which door was asked, or on how many
   * entries the caller batched, would not sort.
   *
   * `details.differs` names what differed: `type` on an item, and the
   * members of the triple that moved on an edge. A caller that minted the
   * id knows what it sent, and what it needs is which part of the stored
   * row disagrees, because that is what says whether it has a duplicate id
   * or a bug in how it derives one.
   *
   * Not `type_mismatch`, which answers the other question: a body
   * declaring a type that the row it resolved is not, where the row was
   * resolved by its natural key or is the one the path names. The write
   * named no id there, so the declaration is the mistake; here the id is.
   */
  ID_REUSED = "id_reused",
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

/**
 * What a client is told about a code the server can answer: the status it
 * comes with and the condition it stands for.
 *
 * This is the one place a code, its status and its meaning are tied
 * together. `httpStatus` reads it, and the contract's table of codes
 * (`conformance/spec/errors.md`) is written from it, so neither can say
 * something this does not.
 */
interface ErrorCodeInfo {
  /** The HTTP status the code answers with. */
  status: number;
  /**
   * What the table shows in place of `status`, for a code whose status is
   * not its own.
   */
  statusLabel?: string;
  /**
   * The condition, as a client meets it: what is the case
   * when this code comes back, not which line of the server throws it.
   */
  summary: string;
}

/**
 * The code of a fault nothing else named a refusal for. It is not a member
 * of `ErrorCode` because nothing throws it: the error handler answers it for
 * an error no code was given to.
 */
export const INTERNAL_ERROR = "internal_error";

/** Every code the server can answer: the enum and `internal_error`. */
type AnsweredCode = ErrorCode | typeof INTERNAL_ERROR;

/**
 * `bulk_atomic_rollback` is the one code whose status is not its own: a page
 * is refused for the reason the entry inside it was refused, and the outer
 * code says only that the page went back. The `status` here is what the
 * server falls back on.
 */
export const ERROR_CODES: Record<AnsweredCode, ErrorCodeInfo> = {
  [ErrorCode.NOT_FOUND]: {
    status: 404,
    summary: "The request names a path or address the server does not serve.",
  },
  [ErrorCode.ITEM_NOT_FOUND]: {
    status: 404,
    summary:
      "No item the caller may read has this id: it does not exist, is in the bin, or is of a type the caller may not read.",
  },
  [ErrorCode.BLOB_NOT_FOUND]: {
    status: 404,
    summary:
      "No blob the caller may read has this hash, or no attached store holds its bytes.",
  },
  [ErrorCode.VALIDATION_ERROR]: {
    status: 400,
    summary:
      "The request is malformed or breaks a rule that no other code names, such as a bad body, parameter, cursor or limit.",
  },
  [ErrorCode.MISSING_REQUIRED_FIELD]: {
    status: 400,
    summary:
      "A field the operation requires is absent. `details.field` names it.",
  },
  [ErrorCode.UNKNOWN_TYPE]: {
    status: 400,
    summary: "A well-formed type identifier names a type nobody registered.",
  },
  [ErrorCode.INVALID_ID]: {
    status: 400,
    summary: "An item, edge or folder id is not a well-formed identifier.",
  },
  [ErrorCode.VERSION_CONFLICT]: {
    status: 409,
    summary:
      "The write names a version that is no longer the current one. The answer carries the current state.",
  },
  [ErrorCode.READ_VIEW_CHANGED]: {
    status: 409,
    summary:
      "A conditional copy read or copy stream carries a proof for a read view that has since changed. Rebuild the working copy.",
  },
  [ErrorCode.ANCESTOR_UNAVAILABLE]: {
    status: 409,
    summary:
      "The write names a version that has no snapshot the caller may merge against.",
  },
  [ErrorCode.UNAUTHORIZED]: {
    status: 401,
    summary:
      "The request carries no credential the server accepts: none, an unknown or revoked one, or an expired or altered link.",
  },
  [ErrorCode.FORBIDDEN]: {
    status: 403,
    summary:
      "The credential is valid but lacks a standing permission, reach or origin the operation needs.",
  },
  [ErrorCode.TYPE_NOT_PERMITTED]: {
    status: 403,
    summary:
      "The credential holds no grant on the type at the level the operation asks for.",
  },
  [ErrorCode.INVALID_TRANSITION]: {
    status: 400,
    summary:
      "The move is not one the current state of the item or folder allows.",
  },
  [ErrorCode.TYPE_NOT_FOUND]: {
    status: 404,
    summary: "No registered type has this identifier.",
  },
  [ErrorCode.INVALID_CLIENT]: {
    status: 400,
    summary: "The device sign-in page names a client that is not registered.",
  },
  [ErrorCode.RATE_LIMITED]: {
    status: 429,
    summary:
      "The credential, or an inbound endpoint, is past its request cap for the current window.",
  },
  [ErrorCode.CONFLICT]: {
    status: 409,
    summary:
      "The request collides with the current state in a way that no other code names.",
  },
  [ErrorCode.TYPE_ALREADY_EXISTS]: {
    status: 409,
    summary: "A type is already registered under this identifier.",
  },
  [ErrorCode.TYPE_IN_USE]: {
    status: 409,
    summary:
      "Items of the type still exist, the bin included, and the delete did not ask to force.",
  },
  [ErrorCode.EDGE_TYPE_IN_USE]: {
    status: 409,
    summary:
      "Edges of the edge type still exist, and the delete did not ask to force.",
  },
  [ErrorCode.TYPE_HAS_SUBTYPES]: {
    status: 409,
    summary:
      "Another type declares this type as its parent. Forcing the delete does not override this.",
  },
  [ErrorCode.TYPE_CHAIN_UNRESOLVABLE]: {
    status: 409,
    summary:
      "The stored parent chain of a type is circular or too deep to resolve. `PUT /types/{id}` still accepts a corrected schema.",
  },
  [ErrorCode.CORE_TYPE_IMMUTABLE]: {
    status: 403,
    summary:
      "The type ships with the platform, so it cannot be replaced or deleted.",
  },
  [ErrorCode.WEBHOOK_NOT_FOUND]: {
    status: 404,
    summary: "No webhook subscription this credential registered has this id.",
  },
  [ErrorCode.API_KEY_NOT_FOUND]: {
    status: 404,
    summary:
      "No key the caller can reach has this id, or the key was already revoked.",
  },
  [ErrorCode.OAUTH_GRANT_NOT_FOUND]: {
    status: 404,
    summary: "No app grant has this id.",
  },
  [ErrorCode.OWNER_EXISTS]: {
    status: 409,
    summary: "The instance already has an owner.",
  },
  [ErrorCode.OWNER_NOT_FOUND]: {
    status: 404,
    summary: "The instance has no owner yet.",
  },
  [ErrorCode.COMPATIBLE_WITH_VIOLATION]: {
    status: 422,
    summary:
      "A `compatible_with` declaration names a target that does not exist, or leaves out a field the target requires.",
  },
  [ErrorCode.REQUEST_TOO_LARGE]: {
    status: 413,
    summary: "The request body is over the cap for its operation.",
  },
  [ErrorCode.RANGE_NOT_SATISFIABLE]: {
    status: 416,
    summary:
      "A `Range` request asks for bytes the blob does not have. `Content-Range` names its size.",
  },
  [ErrorCode.INVALID_PROPERTIES]: {
    status: 400,
    summary: "An item's properties break the schema of its type.",
  },
  [ErrorCode.INVALID_SCHEMA]: {
    status: 400,
    summary: "A type or edge type carries a schema the server cannot accept.",
  },
  [ErrorCode.INHERITANCE_VIOLATION]: {
    status: 400,
    summary:
      "A type changes the shape of a field it inherits, or a parent gains a field that a child declares with another shape.",
  },
  [ErrorCode.PROPERTY_SHADOWS_FIELD]: {
    status: 400,
    summary:
      "A type declares a field with the name of a first-class item field.",
  },
  [ErrorCode.EDGE_CONSTRAINT_VIOLATION]: {
    status: 400,
    summary:
      "An edge write breaks a constraint of its edge type or of the link graph, such as cardinality, endpoint types or a duplicate.",
  },
  [ErrorCode.EDGE_CYCLE]: {
    status: 400,
    summary:
      "An edge would close a cycle: a self-loop on any edge type, or a loop on an edge type that must stay acyclic.",
  },
  [ErrorCode.EDGE_TYPE_NOT_FOUND]: {
    status: 404,
    summary: "No edge type is registered under this identifier.",
  },
  [ErrorCode.EDGE_PERMISSION_DENIED]: {
    status: 403,
    summary:
      "The credential lacks the edge-type permission the operation needs.",
  },
  [ErrorCode.EDGE_NOT_FOUND]: {
    status: 404,
    summary: "No edge the caller may read has this id.",
  },
  [ErrorCode.BULK_CONFIRMATION_REQUIRED]: {
    status: 400,
    summary:
      "A destructive bulk action was sent without its confirmation literal.",
  },
  [ErrorCode.BULK_CAP_EXCEEDED]: {
    status: 400,
    summary: "A bulk action matched more items than its `max_items` allows.",
  },
  [ErrorCode.BULK_ATOMIC_ROLLBACK]: {
    status: 400,
    statusLabel: "The inner refusal's",
    summary:
      "An atomic bulk page failed on one entry, so nothing was written. `details` names the entry and the refusal.",
  },
  [ErrorCode.BULK_JOB_NOT_FOUND]: {
    status: 404,
    summary: "No bulk action job the caller can see has this id.",
  },
  [ErrorCode.BLOB_LOCATION_NOT_FOUND]: {
    status: 404,
    summary: "The named store holds no copy of the blob, or is not attached.",
  },
  [ErrorCode.COPIES_BELOW_MINIMUM]: {
    status: 409,
    summary:
      "Dropping the copy would leave fewer live copies than the instance's minimum.",
  },
  [ErrorCode.ID_REUSED]: {
    status: 409,
    summary: "A caller-minted id already names a different item or edge.",
  },
  [ErrorCode.HOUSEKEEPING_JOB_NOT_FOUND]: {
    status: 404,
    summary:
      "The instance runs no housekeeping job of this name, or has switched it off.",
  },
  [ErrorCode.HOUSEKEEPING_JOB_RUNNING]: {
    status: 409,
    summary: "The housekeeping job is in the middle of a run.",
  },
  [ErrorCode.CONNECTOR_NOT_FOUND]: {
    status: 404,
    summary: "No connector registration the credential may read has this id.",
  },
  [ErrorCode.CONNECTOR_HELD]: {
    status: 409,
    summary:
      "Another process holds the connector's registration until `details.expires_at`.",
  },
  [ErrorCode.ENDPOINT_NOT_FOUND]: {
    status: 404,
    summary: "The connector's registration has no endpoint with this id.",
  },
  [ErrorCode.DELIVERY_NOT_FOUND]: {
    status: 404,
    summary: "The connector's registration has no delivery with this id.",
  },
  [ErrorCode.INBOUND_UNAVAILABLE]: {
    status: 503,
    summary:
      "An inbound endpoint cannot take a delivery now, because its connector's backlog is full or the instance holds as many bodies in flight as it allows. Retry later.",
  },
  [ErrorCode.REQUEST_TIMEOUT]: {
    status: 408,
    summary:
      "An inbound webhook delivery did not finish arriving before its deadline.",
  },
  [ErrorCode.STREAM_CAPACITY_EXHAUSTED]: {
    status: 503,
    summary:
      "The instance is serving as many live event streams as it allows. `details.reason` is `viewer_cap`.",
  },
  [ErrorCode.WRITE_CONTENTION]: {
    status: 503,
    summary:
      "A write could not get the store's write lock within the busy budget. Retry it unchanged.",
  },
  [ErrorCode.INSUFFICIENT_STORAGE]: {
    status: 507,
    summary:
      "The volume the instance writes to has no room for the request, or the request would leave less free than the instance's reserve. Nothing was kept unless `details.write_outcome` is `unknown`.",
  },
  [ErrorCode.SOURCE_ID_CONFLICT]: {
    status: 409,
    summary:
      "A change to `source_id` names a natural key that another item already holds under the same source.",
  },
  [ErrorCode.LINK_TAKEN]: {
    status: 409,
    summary:
      "A write would give an item a link that another item of its type holds.",
  },
  [ErrorCode.TYPE_MISMATCH]: {
    status: 409,
    summary:
      "The request declares a type other than the type of the item it resolved.",
  },
  // A genuine 409: the key is held by a request in flight, or contention
  // kept it changing hands. Something else got there first, which is
  // exactly what a client branching on 409 expects to mean.
  [ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT]: {
    status: 409,
    summary:
      "An `Idempotency-Key` is held by another request, or kept changing hands. Retry.",
  },
  // 422 rather than 409: the request is refused because of what the caller
  // sent, not because of what the server holds, and a client branching on
  // 409 to mean "somebody else got there first" must not catch this.
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: {
    status: 422,
    summary:
      "An `Idempotency-Key` is sent with a different request than the one it first named.",
  },
  // 422 for the same reason. Nothing got there first: the record exists,
  // the write is not repeated, and the only thing missing is the body, so a
  // client that reads 409 as a conflict would act on this exactly wrongly.
  [ErrorCode.IDEMPOTENCY_RESULT_NOT_RETAINED]: {
    status: 422,
    summary:
      "An `Idempotency-Key` repeats a request whose first answer was too large to keep. `details.original_status` is the status it carried.",
  },
  [INTERNAL_ERROR]: {
    status: 500,
    summary:
      "A fault that nothing else names a refusal for. The answer says nothing of what failed.",
  },
};

/** Returns the HTTP status code for a given error code. */
export function httpStatus(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

/** Structured error thrown by the server. Carries a typed code and HTTP status. */
export class MarfaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  /**
   * `status` comes from `ERROR_CODES` and is overridden by one code.
   *
   * That table is the single place a code and its status are tied together,
   * and keeping it that way is what stops the two drifting across a
   * hundred throw sites. The exception is `bulk_atomic_rollback`, whose
   * status is not its own: a page is refused for the reason the entry
   * inside it was refused, and the outer code says only that the page
   * went back. A caller sorts by status before it reads a code, so a
   * permission refusal answered `400` there is filed under "fix the
   * request", which is the one thing that caller cannot do about it.
   */
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    status?: number,
  ) {
    super(message);
    this.name = "MarfaError";
    this.code = code;
    this.status = status ?? ERROR_CODES[code].status;
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
