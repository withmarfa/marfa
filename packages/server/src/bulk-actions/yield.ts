import { setImmediate } from "node:timers/promises";
import { holdArmed, holdAt } from "../control/faults.js";
import { markWriteProgress } from "../storage/sqlite/connection.js";
import { noteBulkWork } from "./memory-release.js";

// Synchronous SQLite awaits drain microtasks; HTTP needs a macrotask turn.
// Call only between bounded units of work: committed chunks, selection pages,
// a bulk page's entries, or an archive restore's batches inside its one
// transaction. `writing` keeps a write that meets the lock, in a transaction
// or not, waiting for the open transaction rather than refused while it still
// makes progress. A write under `withoutWriteWait` is still refused at once.
// Each call also notes that bulk work is running, so the memory it grew is
// handed back once the work stops.
export async function yieldBulkWork(
  options: { writing?: boolean } = {},
): Promise<void> {
  if (options.writing) markWriteProgress();
  noteBulkWork();
  await setImmediate();
}

// Holds a bulk page before an entry under `hold:bulk-page`, telling writes
// queued behind its transaction that it is still working.
export async function holdBulkEntry(): Promise<void> {
  if (!holdArmed("bulk-page")) return;
  const beat = setInterval(markWriteProgress, 25);
  try {
    await holdAt("bulk-page");
  } finally {
    clearInterval(beat);
  }
}
