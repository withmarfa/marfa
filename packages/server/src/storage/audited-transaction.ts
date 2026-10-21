import { auditActor, withAuditActor } from "../auth/audit-actor.js";
import { inRequest } from "../auth/request-authority.js";
import { generateId } from "@withmarfa/shared";
import type { AuditLogEntry, Storage } from "./interface.js";
import {
  TransactionFailure,
  transactionControl,
  reconcileCommitHooks,
} from "./sqlite/transaction-control.js";
import { failAt, faultsArmed, holdArmed, holdAt } from "../control/faults.js";
import { lockNotFree } from "./sqlite/connection.js";
import { auditUnderFaults } from "./sqlite/injected-failure.js";

/** A null entry is an acknowledged or refused outcome with no represented write. */
export async function runAuditedTransaction<T>(
  storage: Storage,
  work: () => T | Promise<T>,
  entry: AuditLogEntry | ((result: T) => AuditLogEntry | null),
  options: { retainCommitHooksOnUncertain?: boolean } = {},
  // A conditional audit cannot name its action until work has returned.
  action?: string,
): Promise<T> {
  const nested = transactionControl.getStore() !== undefined;
  if (faultsArmed() && !nested && holdArmed("write"))
    await holdAt("write", typeof entry === "function" ? action : entry.action);
  // Only a write a request starts counts toward the lock fault: the server's
  // own writes would otherwise take it from the request it is armed for.
  if (!nested && inRequest() && failAt("lock")) throw lockNotFree();
  const id = generateId();
  let result!: T;
  const witness = { recorded: false };
  try {
    return await storage.runInTransaction(
      async () => {
        const actor = await auditActor();
        result = await withAuditActor(() => Promise.resolve(actor), work);
        const supplied = typeof entry === "function" ? entry(result) : entry;
        const record =
          supplied === null
            ? null
            : {
                ...supplied,
                actor: supplied.actor === undefined ? actor : supplied.actor,
              };
        if (record !== null) {
          if (!nested && faultsArmed())
            await auditUnderFaults(
              storage,
              record,
              id,
              transactionControl.getStore(),
            );
          else await storage.audit.log(record, id);
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
