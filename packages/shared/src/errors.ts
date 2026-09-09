import type { ErrorResponse } from "./types.js";

/** All error codes used across the Marfa API. */
export enum ErrorCode {
  NOT_FOUND = "not_found",
  ITEM_NOT_FOUND = "item_not_found",
  BLOB_NOT_FOUND = "blob_not_found",
  VALIDATION_ERROR = "validation_error",
  MISSING_REQUIRED_FIELD = "missing_required_field",
  INVALID_TYPE = "invalid_type",
  /**
   * A create / upsert named a type identifier that is well-formed but not
   * registered. Distinct from `INVALID_TYPE` (the identifier is malformed,
   * e.g. contains a slash) and `TYPE_NOT_FOUND` (a `/types/:id` lookup miss).
   * An unregistered type has no schema to validate against, so the write is
   * rejected rather than persisting an unvalidated, typo-prone item. Register
   * the type via `POST /types` first.
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
   * The row is an integration's copy of an external record; only the
   * owning integration writes it. Promote it to edit your own copy.
   */
  INTEGRATION_OWNED = "integration_owned",
  TYPE_NOT_PERMITTED = "type_not_permitted",
  /**
   * A credential whose content reach is narrower than the space attempted an
   * operation only a credential reaching all of it may perform.
   *
   * Distinct from the generic `FORBIDDEN` it shares a status with, because
   * holding more space permissions will not help: what the caller may
   * administer and what it may read are separate axes, and this is a refusal
   * on the second one. Outbound webhooks are the case this exists for — a
   * subscription is space-level and carries no credential of its own, so
   * anything it delivers is bounded by the space rather than by the reach of
   * whoever registered it.
   */
  SCOPED_CREDENTIAL_NOT_PERMITTED = "scoped_credential_not_permitted",
  INVALID_TRANSITION = "invalid_transition",
  TYPE_NOT_FOUND = "type_not_found",
  DUPLICATE_SOURCE = "duplicate_source",
  INVALID_GRANT = "invalid_grant",
  INVALID_CLIENT = "invalid_client",
  INVALID_SCOPE = "invalid_scope",
  /**
   * RFC 6749 §5.2 parity. The OAuth device-flow endpoints continue to
   * emit the flat RFC error shape (`{ error: "invalid_request", ... }`)
   * directly for spec compliance; this enum entry exists so non-OAuth
   * call sites that want a generic "the request itself is malformed"
   * code can throw a `MarfaError` instead of leaning on `VALIDATION_ERROR`
   * (which is reserved for body-shape failures).
   */
  INVALID_REQUEST = "invalid_request",
  EXPIRED_TOKEN = "expired_token",
  TOKEN_REUSE_DETECTED = "token_reuse_detected",
  RATE_LIMITED = "rate_limited",
  /**
   * Per-space resource cap exceeded. Body details carry the resource
   * (`items` | `webhooks` | `blobs` | `storage_bytes` | `rate_per_minute`),
   * the configured limit, and the current count before the request was
   * rejected — operators wire alerts off the shape so a space approaching
   * their cap can be flagged early.
   */
  QUOTA_EXCEEDED = "quota_exceeded",
  /**
   * The operator has suspended this space. The auth middleware rejects every
   * non-GET request with this code; reads pass through. The operator key
   * bypasses the gate, so a suspended space can still be inspected.
   */
  SPACE_SUSPENDED = "space_suspended",
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
  /**
   * A credential cannot be removed while a connection that is not
   * revoked still references it. Details carry `connection_ids`.
   */
  CREDENTIAL_IN_USE = "credential_in_use",
  CORE_TYPE_IMMUTABLE = "core_type_immutable",
  WEBHOOK_NOT_FOUND = "webhook_not_found",
  /**
   * A signed-webhook receiver rejected a request that omitted the
   * verification headers required to compute the signature. Distinct from
   * `INBOUND_WEBHOOK_VERIFICATION_FAILED` (which means headers were present
   * but the signature didn't validate).
   */
  WEBHOOK_SIGNATURE_MISSING = "webhook_signature_missing",
  /**
   * A signed-webhook receiver rejected a request whose signature headers
   * were present but failed verification against the configured shared secret.
   */
  WEBHOOK_SIGNATURE_INVALID = "webhook_signature_invalid",
  /**
   * A signed-webhook receiver has no shared secret configured. Returned as
   * HTTP 503 so the upstream retries after the operator wires the secret.
   */
  WEBHOOK_SECRET_NOT_CONFIGURED = "webhook_secret_not_configured",
  /**
   * A signed-webhook receiver verified the signature but the payload itself
   * could not be parsed as the expected JSON shape.
   */
  WEBHOOK_PAYLOAD_INVALID = "webhook_payload_invalid",
  INBOUND_WEBHOOK_NOT_FOUND = "inbound_webhook_not_found",
  /**
   * The inbound webhook subscription is `disabled = true`. Receipts to a
   * disabled subscription return HTTP 410 to tell the sender to stop —
   * standard signal in webhook-receiver protocols.
   */
  INBOUND_WEBHOOK_DISABLED = "inbound_webhook_disabled",
  INBOUND_WEBHOOK_EVENT_NOT_FOUND = "inbound_webhook_event_not_found",
  /** Verification adapter could not validate the request body / headers. */
  INBOUND_WEBHOOK_VERIFICATION_FAILED = "inbound_webhook_verification_failed",
  /**
   * The connection's stored OAuth refresh has failed terminally (the
   * upstream returned `invalid_grant` or equivalent, or no refresh token
   * is available). The connection's `runtime_status` has been flipped to
   * `reauth_required`; the user must re-authorize the integration before
   * any further proxy calls will succeed.
   */
  OAUTH_PROXY_REAUTH_REQUIRED = "oauth_proxy_reauth_required",
  /**
   * No OAuth token row was found for the connection — the proxy was
   * called before initial authorization, or after the token row was
   * deleted on revocation. Distinct from `reauth_required` (which means
   * we had a token but refresh failed).
   */
  OAUTH_PROXY_TOKEN_MISSING = "oauth_proxy_token_missing",
  /**
   * The proxy could not derive an upstream URL — typically because the
   * connection's `configuration.upstream_base_url` is unset or invalid.
   */
  OAUTH_PROXY_UPSTREAM_INVALID = "oauth_proxy_upstream_invalid",
  /**
   * `system.connection` item lookup by id returned no row. Allows clients
   * to branch on the specific resource type rather than a generic `NOT_FOUND`.
   */
  CONNECTION_NOT_FOUND = "connection_not_found",
  /**
   * The `system.connection` exists but has left `active` — the bounded
   * `system.*` lifecycle's terminal `revoked` state. Distinct from the
   * generic `FORBIDDEN` it shares a status with: a caller has to be able
   * to tell "this one connection is finished" from "your credential is
   * not allowed to do this at all". The runtime's dispatch path
   * branches on exactly that difference, and reads the wrong branch as
   * permission to tear a connection's schedule down for good.
   */
  CONNECTION_NOT_ACTIVE = "connection_not_active",
  /**
   * API key lookup by id returned no row. Replaces generic `NOT_FOUND`
   * on `/keys/:id` routes.
   */
  API_KEY_NOT_FOUND = "api_key_not_found",
  /**
   * Integration manifest lookup by id (or `name@version`) returned no row
   * in the registry. Replaces generic `NOT_FOUND` on the integrations
   * registry surface.
   */
  INTEGRATION_NOT_FOUND = "integration_not_found",
  /**
   * OAuth grant (`oauth_codes` / token row) lookup returned no row.
   * Replaces generic `NOT_FOUND` on grant-revocation and
   * grant-introspection paths.
   */
  OAUTH_GRANT_NOT_FOUND = "oauth_grant_not_found",
  /**
   * Lease issuance was requested for a `capability_id` the supplied
   * Integration manifest doesn't declare with `oauth_requirements:
   * <capability>: "leased"`.
   */
  LEASE_CAPABILITY_NOT_DECLARED = "lease_capability_not_declared",
  /**
   * Requested TTL is outside the allowed range — below the per-capability
   * floor or above the route-level ceiling (default 3600s).
   */
  LEASE_TTL_OUT_OF_RANGE = "lease_ttl_out_of_range",
  /** Lease lookup by id (revoke / introspect) found no matching row. */
  LEASE_TOKEN_NOT_FOUND = "lease_token_not_found",
  /** Validation found a row but its `expires_at` has passed. */
  LEASE_TOKEN_EXPIRED = "lease_token_expired",
  /** Validation found a row whose `revoked_at` is set. */
  LEASE_TOKEN_REVOKED = "lease_token_revoked",
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
   * `source_id`, `timestamp`, `version`, `schema_version`,
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
  /** An edge creation would close a cycle (parent-of or supersedes). */
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
  // ---------------------------------------------------------------------
  // Email transport
  // ---------------------------------------------------------------------
  /**
   * The server has no email backend configured (`MARFA_EMAIL_BACKEND`
   * unset or `none`) but a flow that depends on outbound email was
   * invoked (forgot-password, magic-link, email-verify). Operators
   * configure a backend to enable these flows; the alternative is a
   * silent dead-letter, which the server refuses.
   */
  EMAIL_TRANSPORT_NOT_CONFIGURED = "email_transport_not_configured",
  /**
   * Every streaming connection slot is in use and none freed within the
   * reservation window. Retryable by definition: streams end and slots
   * free, so a client seeing this backs off and asks again.
   */
  STREAM_CAPACITY_EXHAUSTED = "stream_capacity_exhausted",
  /**
   * Every consent-serialization slot is in use and none freed within the
   * reservation window. Same retryable shape as the streaming sibling:
   * consent flows are short, so a caller seeing this asks again.
   */
  CONSENT_CAPACITY_EXHAUSTED = "consent_capacity_exhausted",
  /**
   * The deployment runs no integration runtime (SQLite dialect), so the
   * dead-letter operator surface has no queue to read. Not retryable
   * without a config change.
   */
  LOCAL_RUNTIME_NOT_AVAILABLE = "local_runtime_not_available",
  /**
   * The transport returned a non-retryable failure (4xx from
   * Cloudflare Email, permanent SMTP rejection). Distinct from a
   * transient failure (5xx / 429 / network) which the route handler
   * may retry.
   */
  EMAIL_SEND_FAILED = "email_send_failed",
  /**
   * Handle claim was rejected because the value names a reserved root:
   * one of the type grammar's namespace tiers, or a scope family root. A handle
   * appears as the first segment of a type identifier, so a claim on one
   * of these would let its holder register into the platform's own
   * vocabulary.
   *
   * Distinct from `validation_error` because the two say different things
   * to the claimant. This one means the handle is well-formed and refused
   * for what it names; `validation_error` means it never cleared the
   * grammar. A value that fails both reports this one, since the routes
   * check the root before the format.
   */
  HANDLE_RESERVED = "handle_reserved",
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
   * A write resolved a row that a *different, still-installed* connection
   * of the same integration wrote. Refused rather than merged.
   *
   * `source` is stamped `integration:<manifest name>` and is deliberately
   * one value for the whole integration in a space (D34), so that
   * reinstalling adopts the corpus it created rather than duplicating it.
   * The cost is that two live connections of one integration share a
   * natural-key namespace, and nothing in `(source, source_id)` tells them
   * apart. The row's recorded writer is what does.
   *
   * **The refusal is on liveness, not on difference.** A row whose recorded
   * writer is gone — uninstalled, or never recorded — is adopted and
   * re-stamped, which is exactly D34's reinstall behaviour and must not
   * change. Only a live sibling refuses.
   *
   * **Permanent, not transient: a handler must not retry it.** Retrying
   * cannot succeed while the owning connection stays installed. The remedy
   * is for the handler to scope its `source_id` per upstream source
   * (decision 18) so the two connections stop competing for one key.
   *
   * **It refuses a write and asserts nothing wider.** Lifecycle gestures —
   * transition, restore, delete — are deliberately exempt from this guard,
   * so a connection refused here can still trash the same row. Reading this
   * as "the row belongs to that connection" would be reading a guarantee
   * the platform does not defend.
   *
   * **The create race answers a different code.** Two connections creating
   * the same `source_id` concurrently, where both pre-checks miss, trip the
   * `idx_items_source_dedup` unique constraint and surface as
   * `SOURCE_ID_CONFLICT`. Loud either way; the absence of this code there
   * is not a gap.
   */
  PROVENANCE_COLLISION = "provenance_collision",
  /**
   * A write resolved an existing row whose type is not the one the request
   * declared. The write is refused rather than reinterpreted.
   *
   * Every door that addresses a row by something other than its type —
   * `(source, source_id)` on `POST /items` and `POST /items/bulk`, and an
   * id on `PATCH /items/{id}` and on the bulk path — used to take the
   * resolved row's type and merge the submitted properties onto it. A caller declaring one type and
   * landing on another got a 200 and a row of the other shape. That is
   * silent, and it is reachable from both directions: a mapping added
   * re-types on the way in, a mapping removed re-types on the way back.
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
  [ErrorCode.INVALID_TYPE]: 400,
  [ErrorCode.UNKNOWN_TYPE]: 400,
  [ErrorCode.INVALID_ID]: 400,
  [ErrorCode.VERSION_CONFLICT]: 409,
  [ErrorCode.ANCESTOR_UNAVAILABLE]: 409,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.INTEGRATION_OWNED]: 403,
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
  [ErrorCode.QUOTA_EXCEEDED]: 429,
  [ErrorCode.SPACE_SUSPENDED]: 403,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.TYPE_ALREADY_EXISTS]: 409,
  [ErrorCode.TYPE_IN_USE]: 409,
  [ErrorCode.TYPE_HAS_SUBTYPES]: 409,
  [ErrorCode.TYPE_CHAIN_UNRESOLVABLE]: 409,
  [ErrorCode.CREDENTIAL_IN_USE]: 409,
  [ErrorCode.CORE_TYPE_IMMUTABLE]: 403,
  [ErrorCode.WEBHOOK_NOT_FOUND]: 404,
  [ErrorCode.WEBHOOK_SIGNATURE_MISSING]: 400,
  [ErrorCode.WEBHOOK_SIGNATURE_INVALID]: 401,
  [ErrorCode.WEBHOOK_SECRET_NOT_CONFIGURED]: 503,
  [ErrorCode.WEBHOOK_PAYLOAD_INVALID]: 400,
  [ErrorCode.INBOUND_WEBHOOK_NOT_FOUND]: 404,
  [ErrorCode.INBOUND_WEBHOOK_DISABLED]: 410,
  [ErrorCode.INBOUND_WEBHOOK_EVENT_NOT_FOUND]: 404,
  [ErrorCode.INBOUND_WEBHOOK_VERIFICATION_FAILED]: 401,
  [ErrorCode.OAUTH_PROXY_REAUTH_REQUIRED]: 401,
  [ErrorCode.OAUTH_PROXY_TOKEN_MISSING]: 404,
  [ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID]: 422,
  [ErrorCode.CONNECTION_NOT_FOUND]: 404,
  [ErrorCode.CONNECTION_NOT_ACTIVE]: 403,
  [ErrorCode.API_KEY_NOT_FOUND]: 404,
  [ErrorCode.INTEGRATION_NOT_FOUND]: 404,
  [ErrorCode.OAUTH_GRANT_NOT_FOUND]: 404,
  [ErrorCode.LEASE_CAPABILITY_NOT_DECLARED]: 422,
  [ErrorCode.LEASE_TTL_OUT_OF_RANGE]: 400,
  [ErrorCode.LEASE_TOKEN_NOT_FOUND]: 404,
  [ErrorCode.LEASE_TOKEN_EXPIRED]: 401,
  [ErrorCode.LEASE_TOKEN_REVOKED]: 401,
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
  [ErrorCode.EMAIL_TRANSPORT_NOT_CONFIGURED]: 503,
  [ErrorCode.STREAM_CAPACITY_EXHAUSTED]: 503,
  [ErrorCode.CONSENT_CAPACITY_EXHAUSTED]: 503,
  [ErrorCode.LOCAL_RUNTIME_NOT_AVAILABLE]: 503,
  [ErrorCode.EMAIL_SEND_FAILED]: 502,
  [ErrorCode.HANDLE_RESERVED]: 400,
  [ErrorCode.SOURCE_ID_CONFLICT]: 409,
  [ErrorCode.PROVENANCE_COLLISION]: 409,
  [ErrorCode.TYPE_MISMATCH]: 409,
  // A genuine 409: the key is held by a request in flight, or contention
  // kept it changing hands. Something else got there first, which is
  // exactly what a client branching on 409 expects to mean.
  [ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT]: 409,
  // 422 rather than 409: the request is refused because of what the caller
  // sent, not because of what the server holds, and a client branching on
  // 409 to mean "somebody else got there first" must not catch this.
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 422,
  // 422 for the same reason, applied consistently. Nothing got there
  // first: the record exists, the write is not repeated, and the only
  // thing missing is the body — so a client that reads 409 as a conflict
  // would act on this exactly wrongly. Keeping it a 409 while the reuse
  // code moved to 422 was the inconsistency, not the reasoning.
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
