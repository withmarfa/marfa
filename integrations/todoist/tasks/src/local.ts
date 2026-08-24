/**
 * Local-runtime entry for the todoist/tasks integration. Counterpart to
 * `worker.ts`; the server's local-runtime substrate `await import()`s
 * this module inside each worker_thread so the handler registry is
 * seeded.
 */
import { registerHandlers } from "./handlers.js";
import { TODOIST_MANIFEST } from "./manifest.js";

registerHandlers();

export { TODOIST_MANIFEST as manifest };
export { registerHandlers };
