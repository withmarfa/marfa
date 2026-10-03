import { AsyncLocalStorage } from "node:async_hooks";

type Usability = "usable" | "ended" | "poisoned";
export type TransactionOutcome =
  "active" | "rolled_back" | "committed" | "unknown";

/** Shared by the root transaction and every savepoint, including native cleanup. */
export class TransactionControl {
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
      this.pendingDiagnostics.push(originalErrorMessage(cause));
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

/** Internal only: the wire envelope receives the original message, never SQL or diagnostics. */
export class TransactionFailure extends Error {
  readonly code = "TRANSACTION_CLOSED";
  readonly diagnostics: string[] = [];

  constructor(
    cause: unknown,
    readonly control: TransactionControl,
  ) {
    super(originalErrorMessage(cause), { cause });
    this.name = "TransactionFailure";
  }

  addDiagnostic(error: unknown): void {
    if (this.diagnostics.length < 4)
      this.diagnostics.push(originalErrorMessage(error));
  }
}

export function originalErrorMessage(error: unknown): string {
  let message = "The transaction could not complete";
  for (let value = error, depth = 0; value != null && depth < 8; depth++) {
    if (value instanceof Error) message = value.message;
    else if (typeof value === "string") message = value;
    if (typeof value !== "object") break;
    value = (value as { cause?: unknown }).cause;
  }
  return message.slice(0, 512);
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
