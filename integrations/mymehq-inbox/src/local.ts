/**
 * Local-runtime entry for the mymehq.inbox integration (T-174).
 * Same shape as `_template/src/local.ts`; see that file for context.
 */
import { registerHandlers } from "./handlers.js";
import { MYMEHQ_INBOX_MANIFEST } from "./manifest.js";

registerHandlers();

export { MYMEHQ_INBOX_MANIFEST as manifest };
export { registerHandlers };
