import type { ConflictSnapshot, Edge } from "@withmarfa/shared";

/**
 * Base error thrown from every SDK HTTP failure path. Consumers catch on
 * this class or one of its typed subclasses (`NotFoundError`,
 * `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).
 *
 * Deliberately distinct from the `MarfaError` in `@withmarfa/shared`. The
 * shared version is constructed server-side from an `ErrorCode` enum and
 * derives its HTTP status through an internal map; this SDK version is
 * constructed from an error response on the wire, so `code` is an opaque
 * string (forward-compatible with server codes the SDK hasn't been
 * regenerated against yet) and `status` is the HTTP status the server
 * actually returned. The two classes serve symmetrical but distinct
 * roles; do not try to unify them.
 */
export class MarfaError extends Error {
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
    this.name = "MarfaError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Status-coded subclasses preserve the server-supplied `code` so callers
 * can branch on specific codes (`bulk_cap_exceeded`, `edge_not_found`,
 * `reset_disabled`, …) while still matching `instanceof NotFoundError`
 * etc. for generic handling. The status family (4xx bucket) is
 * communicated by the class; the specific code is communicated by the
 * `code` field. When the server omits a code, the canonical value for
 * the status family is used as a fallback.
 */
export class NotFoundError extends MarfaError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code?: string,
  ) {
    super(code ?? "not_found", message, 404, details);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends MarfaError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code?: string,
    /**
     * Defaults to the 400 a server rejection carries. A refusal the client
     * reached on its own passes 0, matching `timeout`, `network_error` and
     * `parse_error` in the transport: `status` reports what the server
     * answered, and nothing answered. Telemetry bucketed on it otherwise
     * records a rejection against an endpoint never contacted.
     */
    status = 400,
  ) {
    super(code ?? "validation_error", message, status, details);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends MarfaError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code?: string,
  ) {
    super(code ?? "unauthorized", message, 401, details);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends MarfaError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code?: string,
  ) {
    super(code ?? "forbidden", message, 403, details);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends MarfaError {
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

/**
 * A write was based on a version whose snapshot the server no longer holds,
 * so there was no common ancestor to merge against.
 *
 * Deliberately not `ConflictError`. That one carries an ancestor and a list of
 * fields that collided, and here there is neither: nothing can be shown *not*
 * to have collided, so a caller treating this as an ordinary conflict resolves
 * every field it sent and, under a keep-both policy, spawns siblings holding
 * text the person never typed. The only correct response is to re-read and
 * re-apply, which is why `current` travels with it.
 */
export class AncestorUnavailableError extends MarfaError {
  readonly current: ConflictSnapshot;
  readonly requestedVersion: number;

  constructor(
    current: ConflictSnapshot,
    requestedVersion: number,
    message: string,
  ) {
    super("ancestor_unavailable", message, 409);
    this.name = "AncestorUnavailableError";
    this.current = current;
    this.requestedVersion = requestedVersion;
  }
}

/**
 * A `PATCH /edges/{id}` carrying a `version` was refused because the edge
 * had moved on. Carries the edge as the server now holds it.
 *
 * Deliberately not `ConflictError`. That one describes an item conflict and
 * exposes an ancestor snapshot, the fields in conflict, and the client's
 * patch, all of which come from machinery edges do not have: there is no
 * per-version history for an edge and no merge policy to consult. An edge
 * conflict has exactly one useful fact in it, which is the current row.
 *
 * Resolution is to re-apply the change over `current` and send again with
 * `current.version` — there is no route that reads a single edge by id, so
 * this error is the client's only way back to a version it can retry with.
 */
export class EdgeConflictError extends MarfaError {
  readonly current: Edge;

  constructor(current: Edge) {
    super(
      "version_conflict",
      `Edge version is stale; current version is ${String(current.version)}`,
      409,
    );
    this.name = "EdgeConflictError";
    this.current = current;
  }
}

/**
 * An async `bulkAction` job reached `status: 'cancelled'` — the job was
 * DELETEd mid-run by the caller or another admin credential. The envelope
 * carries the partial-count state; the SDK surfaces it via this error
 * subclass so callers can react explicitly.
 */
export class BulkJobCancelledError extends MarfaError {
  readonly jobId: string;
  readonly processed: number;
  readonly succeeded: number;
  readonly errored: number;
  constructor(args: {
    jobId: string;
    processed: number;
    succeeded: number;
    errored: number;
  }) {
    super(
      "bulk_job_cancelled",
      `Bulk action job ${args.jobId} was cancelled after ${String(args.processed)} processed`,
      0,
    );
    this.name = "BulkJobCancelledError";
    this.jobId = args.jobId;
    this.processed = args.processed;
    this.succeeded = args.succeeded;
    this.errored = args.errored;
  }
}

/**
 * An async `bulkAction` job reached `status: 'failed'` — the worker hit
 * an unrecoverable error (typically a storage-level problem). The `error`
 * field on the envelope carries the underlying reason; surfaced via this
 * subclass.
 */
export class BulkJobFailedError extends MarfaError {
  readonly jobId: string;
  readonly reason: string;
  constructor(args: { jobId: string; reason: string }) {
    super(
      "bulk_job_failed",
      `Bulk action job ${args.jobId} failed: ${args.reason}`,
      0,
    );
    this.name = "BulkJobFailedError";
    this.jobId = args.jobId;
    this.reason = args.reason;
  }
}
