/**
 * Local-runtime entry for the template integration (T-174).
 *
 * Counterpart to `worker.ts` (the Cloudflare-side entry). Imported by
 * the server's local runtime substrate via
 * `integrations/_template/dist/local.js` at boot — the substrate
 * `await import()`s this module inside each `worker_thread` so the
 * thread's `@withmarfa/runtime-sdk` handler registry is seeded.
 *
 * Same handler module the Worker entry uses; only the substrate-side
 * wiring differs.
 */
import { registerHandlers } from "./handlers.js";
import { TEMPLATE_MANIFEST } from "./manifest.js";

registerHandlers();

export { TEMPLATE_MANIFEST as manifest };
export { registerHandlers };
