/**
 * Local-runtime entry for the google/youtube integration.
 * Same scaffold as google/contacts/src/local.ts.
 */
import { registerHandlers } from "./handlers.js";
import { GOOGLE_YOUTUBE_MANIFEST } from "./manifest.js";

registerHandlers();

export { GOOGLE_YOUTUBE_MANIFEST as manifest };
export { registerHandlers };
