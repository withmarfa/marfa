/**
 * Cloudflare Worker entrypoint for the Google YouTube integration.
 *
 * Wiring shape (mirrors the other google.* integrations):
 *   1. Register the schedule handler at module load.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Export a default `{ fetch, queue, scheduled }` built from the SDK
 *      helper. One queue family: scheduled-poll (no reactive-run,
 *      no webhook-receipt — this integration is inbound + schedule
 *      only).
 */
import { createIntegrationWorker } from "@mymehq/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { GOOGLE_YOUTUBE_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: GOOGLE_YOUTUBE_MANIFEST.name,
  echo: GOOGLE_YOUTUBE_MANIFEST.bidirectional_handling,
});
