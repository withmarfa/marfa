import { setImmediate } from "node:timers/promises";
import { markWriteProgress } from "../storage/sqlite/connection.js";

// Synchronous SQLite awaits drain microtasks; HTTP needs a macrotask turn.
// Call only between bounded units of work: committed chunks, selection pages,
// a bulk page's entries, or an archive restore's batches inside its one
// transaction. `writing` keeps a write that meets the lock, in a transaction
// or not, waiting for the open transaction rather than refused while it still
// makes progress. A write under `withoutWriteWait` is still refused at once.
export async function yieldBulkWork(
  options: { writing?: boolean } = {},
): Promise<void> {
  if (options.writing) markWriteProgress();
  await setImmediate();
}
