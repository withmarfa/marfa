/**
 * Cloudflare Worker entrypoint for the Google Calendar integration.
 *
 * Wiring shape (mirrors the other in-tree integrations):
 *   1. Register schedule + item-event + webhook handlers at module load.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Export a default `{ fetch, queue, scheduled }` built from the SDK
 *      helper. The helper consumes the three queue families declared in
 *      `wrangler.toml` and dispatches by manifest name.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { GOOGLE_CALENDAR_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: GOOGLE_CALENDAR_MANIFEST.name,
  echo: GOOGLE_CALENDAR_MANIFEST.bidirectional_handling,
});
