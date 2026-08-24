/**
 * Local-runtime entry for the google/contacts integration.
 * Same scaffold as google/tasks/src/local.ts.
 */
import { registerHandlers } from "./handlers.js";
import { GOOGLE_CONTACTS_MANIFEST } from "./manifest.js";

registerHandlers();

export { GOOGLE_CONTACTS_MANIFEST as manifest };
export { registerHandlers };
