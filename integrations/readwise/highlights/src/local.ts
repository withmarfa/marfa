/**
 * Local-runtime entry. The server's local-runtime substrate imports
 * `dist/local.js` at boot and seeds the handler registry.
 */
import { registerHandlers } from "./handlers.js";
import { READWISE_MANIFEST } from "./manifest.js";

registerHandlers();

export { READWISE_MANIFEST as manifest };
export { registerHandlers };
