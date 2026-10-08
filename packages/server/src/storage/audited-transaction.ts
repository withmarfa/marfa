import { generateId } from "@withmarfa/shared";
import type { AuditLogEntry, Storage } from "./interface.js";
import {
  TransactionFailure,
  transactionControl,
  reconcileCommitHooks,
} from "./sqlite/transaction-control.js";

/** A null entry is an acknowledged or refused outcome with no represented write. */
export async function runAuditedTransaction<T>(
  storage: Storage,
  work: () => T | Promise<T>,
  entry: AuditLogEntry | ((result: T) => AuditLogEntry | null),
  options: { retainCommitHooksOnUncertain?: boolean } = {},
): Promise<T> {
  const nested = transactionControl.getStore() !== undefined;
  const id = generateId();
  let result!: T;
  const witness = { recorded: false };
  try {
    return await storage.runInTransaction(
      async () => {
        result = await work();
        const record = typeof entry === "function" ? entry(result) : entry;
        if (record !== null) {
          await storage.audit.log(record, id);
          witness.recorded = true;
        }
        return result;
      },
      { retainCommitHooksOnUncertain: true },
    );
  } catch (error) {
    // The audit is the durable witness for this exact unit, never a second write.
    if (
      !nested &&
      error instanceof TransactionFailure &&
      error.control.outcome === "unknown"
    ) {
      if (witness.recorded) {
        try {
          const committed = await storage.runInTransaction(() =>
            storage.audit.has(id),
          );
          if (committed) {
            reconcileCommitHooks(error, "committed");
            return result;
          }
        } catch {
          // A failed read cannot settle the outcome.
        }
      }
      // Absence cannot distinguish rollback from a witness retired while this
      // process was suspended. A bulk worker may still own a checkpoint oracle;
      // otherwise end retained delivery explicitly rather than leak its frame.
      if (!options.retainCommitHooksOnUncertain)
        reconcileCommitHooks(error, "unknown");
    }
    throw error;
  }
}
