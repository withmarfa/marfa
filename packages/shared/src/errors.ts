import type { ErrorResponse } from "./types.js";

/** All error codes used across the Myme protocol. */
export enum ErrorCode {
  NOT_FOUND = "not_found",
  VALIDATION_ERROR = "validation_error",
  VERSION_CONFLICT = "version_conflict",
  UNAUTHORIZED = "unauthorized",
  FORBIDDEN = "forbidden",
  INVALID_STATE = "invalid_state",
  TYPE_NOT_FOUND = "type_not_found",
  DUPLICATE_SOURCE = "duplicate_source",
}

/** Maps each error code to its HTTP status code. */
const STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.VERSION_CONFLICT]: 409,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.INVALID_STATE]: 400,
  [ErrorCode.TYPE_NOT_FOUND]: 400,
  [ErrorCode.DUPLICATE_SOURCE]: 409,
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
