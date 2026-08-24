/**
 * Local-runtime entry for the google/calendar integration.
 * Same shape as `_template/src/local.ts`; see that file for context.
 */
import { registerHandlers } from "./handlers.js";
import { GOOGLE_CALENDAR_MANIFEST } from "./manifest.js";

registerHandlers();

export { GOOGLE_CALENDAR_MANIFEST as manifest };
export { registerHandlers };
