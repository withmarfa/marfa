import type { ConflictSnapshot } from "@mymehq/shared";

/**
 * Base error thrown from every SDK HTTP failure path. Consumers catch on
 * this class or one of its typed subclasses (`NotFoundError`,
 * `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).
 *
 * Deliberately distinct from the `MymeError` in `@mymehq/shared`. The
 * shared version is constructed server-side from an `ErrorCode` enum and
 * derives its HTTP status through an internal map; this SDK version is
 * constructed from an error response on the wire, so `code` is an opaque
 * string (forward-compatible with server codes the SDK hasn't been
 * regenerated against yet) and `status` is the HTTP status the server
 * actually returned. The two classes serve symmetrical but distinct
 * roles; do not try to unify them.
 */
export class MymeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "MymeError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends MymeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, 404, details);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends MymeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_error", message, 400, details);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends MymeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("unauthorized", message, 401, details);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends MymeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("forbidden", message, 403, details);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends MymeError {
  readonly current: ConflictSnapshot;
  readonly ancestor: ConflictSnapshot;
  readonly conflictingFields: string[];
  readonly clientPatch: Record<string, unknown>;

  constructor(
    current: ConflictSnapshot,
    ancestor: ConflictSnapshot,
    conflictingFields: string[],
    clientPatch: Record<string, unknown>,
  ) {
    super("version_conflict", "Version conflict", 409);
    this.name = "ConflictError";
    this.current = current;
    this.ancestor = ancestor;
    this.conflictingFields = conflictingFields;
    this.clientPatch = clientPatch;
  }
}
