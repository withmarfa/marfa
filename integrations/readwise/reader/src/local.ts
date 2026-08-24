/**
 * Local-runtime entry. The server's local-runtime substrate imports
 * `dist/local.js` at boot and seeds the handler registry.
 */
import { registerHandlers } from "./handlers.js";
import { READWISE_READER_MANIFEST } from "./manifest.js";

registerHandlers();

export { READWISE_READER_MANIFEST as manifest };
export { registerHandlers };
