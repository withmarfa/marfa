import type { ErrorResponse } from "./types.js";

/** All error codes used across the Myme API. */
export enum ErrorCode {
  NOT_FOUND = "not_found",
  ITEM_NOT_FOUND = "item_not_found",
  THREAD_NOT_FOUND = "thread_not_found",
  BLOB_NOT_FOUND = "blob_not_found",
  VALIDATION_ERROR = "validation_error",
  MISSING_REQUIRED_FIELD = "missing_required_field",
  INVALID_TYPE = "invalid_type",
  INVALID_ID = "invalid_id",
  VERSION_CONFLICT = "version_conflict",
  UNAUTHORIZED = "unauthorized",
  FORBIDDEN = "forbidden",
  TYPE_NOT_PERMITTED = "type_not_permitted",
  INVALID_TRANSITION = "invalid_transition",
  TYPE_NOT_FOUND = "type_not_found",
  DUPLICATE_SOURCE = "duplicate_source",
  INVALID_GRANT = "invalid_grant",
  INVALID_CLIENT = "invalid_client",
  INVALID_SCOPE = "invalid_scope",
  EXPIRED_TOKEN = "expired_token",
  TOKEN_REUSE_DETECTED = "token_reuse_detected",
  RATE_LIMITED = "rate_limited",
  CONFLICT = "conflict",
  TYPE_ALREADY_EXISTS = "type_already_exists",
  TYPE_IN_USE = "type_in_use",
  CORE_TYPE_IMMUTABLE = "core_type_immutable",
  WEBHOOK_NOT_FOUND = "webhook_not_found",
  BLOB_TOO_LARGE = "blob_too_large",
  INVALID_PROPERTIES = "invalid_properties",
  INVALID_SCHEMA = "invalid_schema",
  /**
   * A child type registration redeclares a field that is already defined
   * by an ancestor in its parent chain. V0 spec: inherited fields keep
   * their parent-type meaning in every descendant; redefining breaks the
   * generic-reader contract. See `validateTypeSchema`.
   */
  INHERITANCE_VIOLATION = "inheritance_violation",
  // ---------------------------------------------------------------------
  // Edges (Wave 2 PR 4)
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
}

/** Maps each error code to its HTTP status code. */
const STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ITEM_NOT_FOUND]: 404,
  [ErrorCode.THREAD_NOT_FOUND]: 404,
  [ErrorCode.BLOB_NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.INVALID_TYPE]: 400,
  [ErrorCode.INVALID_ID]: 400,
  [ErrorCode.VERSION_CONFLICT]: 409,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.TYPE_NOT_PERMITTED]: 403,
  [ErrorCode.INVALID_TRANSITION]: 400,
  [ErrorCode.TYPE_NOT_FOUND]: 404,
  [ErrorCode.DUPLICATE_SOURCE]: 409,
  [ErrorCode.INVALID_GRANT]: 400,
  [ErrorCode.INVALID_CLIENT]: 400,
  [ErrorCode.INVALID_SCOPE]: 400,
  [ErrorCode.EXPIRED_TOKEN]: 401,
  [ErrorCode.TOKEN_REUSE_DETECTED]: 400,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.TYPE_ALREADY_EXISTS]: 409,
  [ErrorCode.TYPE_IN_USE]: 409,
  [ErrorCode.CORE_TYPE_IMMUTABLE]: 403,
  [ErrorCode.WEBHOOK_NOT_FOUND]: 404,
  [ErrorCode.BLOB_TOO_LARGE]: 413,
  [ErrorCode.INVALID_PROPERTIES]: 400,
  [ErrorCode.INVALID_SCHEMA]: 400,
  [ErrorCode.INHERITANCE_VIOLATION]: 400,
  [ErrorCode.EDGE_CONSTRAINT_VIOLATION]: 400,
  [ErrorCode.EDGE_CYCLE]: 400,
  [ErrorCode.EDGE_TYPE_NOT_FOUND]: 404,
  [ErrorCode.EDGE_PERMISSION_DENIED]: 403,
  [ErrorCode.EDGE_NOT_FOUND]: 404,
};

/** Returns the HTTP status code for a given error code. */
export function httpStatus(code: ErrorCode): number {
  return STATUS_MAP[code];
}

/**
 * Structured error with code, HTTP status, and optional details.
 * Used throughout the server and SDK for consistent error handling.
 */
export class MymeError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MymeError";
    this.code = code;
    this.status = STATUS_MAP[code];
    this.details = details;
  }

  /** Serializes to the standard error response format. */
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

/** @deprecated Use MymeError instead. */
export const ProtocolError = MymeError;
/** @deprecated Use MymeError instead. */
export type ProtocolError = MymeError;
