import type { RegistrySnapshot } from "@withmarfa/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  errorMessage,
  reportableError,
  withoutFailedQueries,
} from "../../error-text.js";

type Usability = "usable" | "ended" | "poisoned";
export type TransactionOutcome =
  "active" | "rolled_back" | "committed" | "unknown";

export interface StructuralParticipant {
  readonly changed: boolean;
  readonly structuralChanged: boolean;
  seal(): void;
  prepare(): void;
  committed(): void;
  rolledBack(): void;
  unavailable(): void;
  uncertain(
    load: () => Promise<{
      registry: RegistrySnapshot;
      structuralGeneration: string;
    }>,
  ): Promise<void>;
}

/** Shared by the root transaction and every savepoint, including native cleanup. */
export class TransactionControl {
  participant?: StructuralParticipant;
  state: Usability = "usable";
  begun = false;
  outcome: TransactionOutcome = "active";
  callbackCause: unknown;
  private failure: TransactionFailure | undefined;
  private pendingDiagnostics: string[] = [];
  private settled: Exclude<TransactionOutcome, "active"> | undefined;
  private readonly settlementCallbacks: ((
    outcome: Exclude<TransactionOutcome, "active">,
  ) => void)[] = [];

  invalidate(
    cause: unknown,
    state: Exclude<Usability, "usable">,
    outcome: TransactionOutcome,
  ): void {
    this.state = state;
    this.outcome = outcome;
    if (!this.failure) {
      this.failure = new TransactionFailure(cause, this);
      for (const diagnostic of this.pendingDiagnostics)
        this.failure.addDiagnostic(diagnostic);
      this.pendingDiagnostics = [];
    } else if (cause !== this.failure && cause !== this.failure.cause)
      this.failure.addDiagnostic(cause);
  }

  diagnose(cause: unknown): void {
    if (this.failure) this.failure.addDiagnostic(cause);
    else if (this.pendingDiagnostics.length < 4)
      this.pendingDiagnostics.push(rootMessage(cause));
  }

  onReconciled(
    callback: (outcome: Exclude<TransactionOutcome, "active">) => void,
  ): void {
    if (this.settled) callback(this.settled);
    else this.settlementCallbacks.push(callback);
  }

  reconcile(outcome: Exclude<TransactionOutcome, "active">): void {
    if (this.settled) return;
    this.settled = outcome;
    this.outcome = outcome;
    for (const callback of this.settlementCallbacks.splice(0))
      callback(outcome);
  }

  assertUsable(): void {
    if (this.failure) throw this.failure;
  }

  error(): TransactionFailure | undefined {
    return this.failure;
  }
}

/**
 * Internal only: the message and diagnostics are the original's, which a
 * caller may classify by, such as a duplicate key named in the driver's
 * text. Every report receives the database failure in its fixed form, from
 * {@link originalErrorMessage} or the sinks themselves.
 */
export class TransactionFailure extends Error {
  readonly code = "TRANSACTION_CLOSED";
  readonly diagnostics: string[] = [];

  constructor(
    cause: unknown,
    readonly control: TransactionControl,
  ) {
    super(rootMessage(cause), { cause });
    this.name = "TransactionFailure";
  }

  addDiagnostic(error: unknown): void {
    if (this.diagnostics.length < 4) this.diagnostics.push(rootMessage(error));
  }
}

/** The message of the innermost error in the chain, as it was written. */
function rootMessage(error: unknown): string {
  let message = "The transaction could not complete";
  for (let value = error, depth = 0; value != null && depth < 8; depth++) {
    try {
      if (value instanceof Error) message = value.message;
      else if (typeof value === "string") message = value;
      if (typeof value !== "object") break;
      value = (value as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return withoutFailedQueries(message).slice(0, 512);
}

/**
 * What to report of a failure the transaction layer met: the database
 * failure in its fixed form when there is one in the chain, and the
 * innermost error's message otherwise.
 */
export function originalErrorMessage(error: unknown): string {
  return reportableError(error) === error
    ? rootMessage(error)
    : errorMessage(error);
}

export const transactionControl = new AsyncLocalStorage<TransactionControl>();

export function assertTransactionUsable(): void {
  transactionControl.getStore()?.assertUsable();
}

export function reconcileCommitHooks(
  error: unknown,
  outcome: Exclude<TransactionOutcome, "active">,
): void {
  if (error instanceof TransactionFailure) error.control.reconcile(outcome);
}
