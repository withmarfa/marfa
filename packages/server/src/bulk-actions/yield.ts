import { setImmediate } from "node:timers/promises";

// Synchronous SQLite awaits drain microtasks; HTTP needs a macrotask turn.
// Call only between bounded units of work: committed chunks, selection pages,
// or an archive restore's batches inside its one transaction.
export async function yieldBulkWork(): Promise<void> {
  await setImmediate();
}
