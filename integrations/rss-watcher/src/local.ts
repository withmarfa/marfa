/**
 * Local-runtime entry for the rss-watcher integration (T-174). Same
 * shape as `_template/src/local.ts`; see that file for context.
 */
import { registerHandlers } from "./handlers.js";
import { RSS_WATCHER_MANIFEST } from "./manifest.js";

registerHandlers();

export { RSS_WATCHER_MANIFEST as manifest };
export { registerHandlers };
