/**
 * Local-runtime entry for the marfa/inbox integration. Same shape
 * as `_template/src/local.ts`; see that file for context.
 */
import { registerHandlers } from "./handlers.js";
import { WITHMARFA_INBOX_MANIFEST } from "./manifest.js";

registerHandlers();

export { WITHMARFA_INBOX_MANIFEST as manifest };
export { registerHandlers };
