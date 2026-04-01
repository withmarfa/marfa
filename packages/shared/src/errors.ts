import type { ErrorResponse } from "./types.js";

/** All error codes used across the Myme protocol. */
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
};

/** Returns the HTTP status code for a given error code. */
export function httpStatus(code: ErrorCode): number {
  return STATUS_MAP[code];
}

/**
 * Structured protocol error with code, HTTP status, and optional details.
 * Used throughout the server and SDK for consistent error handling.
 */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProtocolError";
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
