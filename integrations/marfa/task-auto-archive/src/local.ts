/**
 * Local-runtime entry for the marfa/task-auto-archive integration. Same
 * shape as `_template/src/local.ts`; see that file for context.
 */
import { registerHandlers } from "./handlers.js";
import { TASK_AUTO_ARCHIVE_MANIFEST } from "./manifest.js";

registerHandlers();

export { TASK_AUTO_ARCHIVE_MANIFEST as manifest };
export { registerHandlers };
