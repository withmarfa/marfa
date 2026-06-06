/**
 * Local-runtime entry for the google-tasks integration.
 * Same scaffold as google-calendar/src/local.ts; see that file for
 * context.
 */
import { registerHandlers } from "./handlers.js";
import { GOOGLE_TASKS_MANIFEST } from "./manifest.js";

registerHandlers();

export { GOOGLE_TASKS_MANIFEST as manifest };
export { registerHandlers };
