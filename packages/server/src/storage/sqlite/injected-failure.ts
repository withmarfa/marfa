import { AsyncLocalStorage } from "node:async_hooks";
import { LibsqlError } from "@libsql/client";
import {
  failAt,
  faultsArmed,
  forgetReach,
  recordFired,
} from "../../control/faults.js";
import type { TransactionControl } from "./transaction-control.js";
import type { AuditLogEntry, Storage } from "../interface.js";

/**
 * The failures a conformance harness asks for through the `fail:<point>`
 * faults of `control/faults.ts`, made the way the driver makes them, so that
 * everything above the driver meets what a failing database gives it.
 *
 * Nothing here runs unless a fault is set, and a fault is set only under
 * `MARFA_TEST_HOOKS`.
 */

/** How a commit fails: the database refuses it, the volume has no room, or it lands and its answer is lost. */
export type CommitFault = "refused" | "full" | "ack-lost";

/** The error the driver raises for a failed statement or commit. */
export function injectedDatabaseError(
  code: "SQLITE_IOERR" | "SQLITE_FULL",
): LibsqlError {
  return code === "SQLITE_FULL"
    ? new LibsqlError(
        "SQLITE_FULL: database or disk is full",
        "SQLITE_FULL",
        undefined,
        13,
      )
    : new LibsqlError(
        "SQLITE_IOERR: disk I/O error",
        "SQLITE_IOERR",
        undefined,
        10,
      );
}

/**
 * Fails a read of the database as the driver fails one when `fail:<point>`
 * acts on this reach. For a read made outside a statement scope, such as the
 * one a read snapshot makes. Call it only while a fault is set.
 */
export function failRead(point: string): void {
  if (failAt(point)) throw injectedDatabaseError("SQLITE_IOERR");
}

interface Scope {
  spent: boolean;
  point: string;
  /** The database ends the statement's transaction as it fails, as it may for a full or failing disk. */
  endsTransaction: boolean;
}

const scope = new AsyncLocalStorage<Scope>();

/**
 * Runs `work`, whose first database statement fails if `fail:<point>` acts
 * on this reach. The failure is the statement's own, raised where the driver
 * raises it, so the query layer wraps it with the statement and the values
 * it was bound to, as it does a real one. `action` is the audit action of
 * the write, for a fault aimed at one.
 */
export function withStatementFault<T>(
  point: string,
  work: () => Promise<T>,
  action?: string,
  options: { endsTransaction?: boolean } = {},
): Promise<T> {
  if (!failAt(point, action, false)) return work();
  // Awaited inside the scope: the query layer's builders run the statement
  // when they are awaited, which would otherwise be after the scope ended.
  const state: Scope = {
    spent: false,
    point,
    endsTransaction: options.endsTransaction ?? false,
  };
  return scope.run(state, async () => {
    try {
      return await work();
    } finally {
      if (!state.spent) forgetReach(point);
    }
  });
}

/** The failure the statement about to run must raise, if its caller is inside {@link withStatementFault} and the fault has not acted yet. */
export function takeStatementFault():
  { error: LibsqlError; endsTransaction: boolean } | undefined {
  if (!faultsArmed()) return undefined;
  const pending = scope.getStore();
  if (pending === undefined || pending.spent) return undefined;
  pending.spent = true;
  recordFired(pending.point);
  return {
    error: injectedDatabaseError("SQLITE_IOERR"),
    endsTransaction: pending.endsTransaction,
  };
}

/**
 * Records the audit entry of a write that a fault may be aimed at: the insert
 * is the scoped statement, and the commit that follows is armed. Reached only
 * while a fault is set.
 */
export async function auditUnderFaults(
  storage: Pick<Storage, "audit">,
  record: AuditLogEntry,
  id: string,
  control: TransactionControl | undefined,
): Promise<void> {
  await withStatementFault(
    "audit",
    async () => {
      await storage.audit.log(record, id);
    },
    record.action,
  );
  armCommitFault(control, record.action);
}

/**
 * Sets the commit of the write that has just recorded `action` to fail, as
 * a `fail:commit`, `fail:commit-full` or `fail:commit-ack` fault says. The
 * transaction's own end raises it.
 */
export function armCommitFault(
  control: TransactionControl | undefined,
  action: string,
): void {
  if (!faultsArmed() || control === undefined) return;
  // Each fault counts the write whether or not another acts on it.
  const refused = failAt("commit", action);
  const full = failAt("commit-full", action);
  const lost = failAt("commit-ack", action);
  if (refused) control.commitFault = "refused";
  else if (full) control.commitFault = "full";
  else if (lost) control.commitFault = "ack-lost";
}

/** The error a commit raises for `fault`. */
export function commitFailure(fault: CommitFault): LibsqlError {
  return injectedDatabaseError(
    fault === "full" ? "SQLITE_FULL" : "SQLITE_IOERR",
  );
}
