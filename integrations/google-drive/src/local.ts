/**
 * Local-runtime entry for the google-drive integration.
 */
import { registerHandlers } from "./handlers.js";
import { GOOGLE_DRIVE_MANIFEST } from "./manifest.js";

registerHandlers();

export { GOOGLE_DRIVE_MANIFEST as manifest };
export { registerHandlers };
