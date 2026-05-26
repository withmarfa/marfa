/**
 * Cloudflare Worker entrypoint for the Google Tasks integration.
 *
 * Wiring shape (mirrors the other google.* integrations):
 *   1. Register schedule + item-event handlers at module load.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Export a default `{ fetch, queue, scheduled }` built from the SDK
 *      helper. The helper consumes the two queue families declared in
 *      `wrangler.toml` (scheduled-poll + reactive-run) and dispatches by
 *      manifest name. No webhook family — Tasks API has no push surface.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { GOOGLE_TASKS_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: GOOGLE_TASKS_MANIFEST.name,
  echo: GOOGLE_TASKS_MANIFEST.bidirectional_handling,
});
