/**
 * Cloudflare Worker entrypoint for the Google Drive integration.
 *
 * Schedule + item-event + webhook handlers registered. Three queue
 * families: scheduled-poll, reactive-run (defensive; direction is
 * inbound), webhook-receipt.
 */
import { createIntegrationWorker } from "@mymehq/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { GOOGLE_DRIVE_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: GOOGLE_DRIVE_MANIFEST.name,
  echo: GOOGLE_DRIVE_MANIFEST.bidirectional_handling,
});
