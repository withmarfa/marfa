/**
 * Local-runtime entry. The server's local substrate imports `dist/local.js`
 * at boot and seeds the handler registry.
 */
import { registerHandlers } from "./handlers.js";
import { PODCASTS_MANIFEST } from "./manifest.js";

registerHandlers();

export { PODCASTS_MANIFEST as manifest };
export { registerHandlers };
