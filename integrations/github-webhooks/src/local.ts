/**
 * Local-runtime entry for the github-webhooks integration (T-174).
 * Same shape as `_template/src/local.ts`; see that file for context.
 */
import { registerHandlers } from "./handlers.js";
import { GITHUB_WEBHOOKS_MANIFEST } from "./manifest.js";

registerHandlers();

export { GITHUB_WEBHOOKS_MANIFEST as manifest };
export { registerHandlers };
