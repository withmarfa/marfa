import { setImmediate } from "node:timers/promises";
import { markWriteProgress } from "../storage/sqlite/connection.js";

// Synchronous SQLite awaits drain microtasks; HTTP needs a macrotask turn.
// Call only between bounded units of work: committed chunks, selection pages,
// a bulk page's entries, or an archive restore's batches inside its one
// transaction. `writing` keeps writes queued behind the open transaction
// waiting for it rather than being refused while it still makes progress.
export async function yieldBulkWork(
  options: { writing?: boolean } = {},
): Promise<void> {
  if (options.writing) markWriteProgress();
  await setImmediate();
}
