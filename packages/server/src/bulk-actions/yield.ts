import { setImmediate } from "node:timers/promises";

// Synchronous SQLite awaits drain microtasks; HTTP needs a macrotask turn.
// Call only between committed chunks or bounded selection pages.
export async function yieldBulkWork(): Promise<void> {
  await setImmediate();
}
