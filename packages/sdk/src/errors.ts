import type { ConflictSnapshot } from "@mymehq/shared";

export class MymeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
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
