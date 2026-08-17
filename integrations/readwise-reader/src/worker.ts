/**
 * Cloudflare Worker entrypoint for the Readwise Reader integration.
 * Registers the inbound schedule and outbound item-event handlers;
 * re-exports PerConnectionState for the DO binding; exports the
 * integration-worker default.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { READWISE_READER_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: READWISE_READER_MANIFEST.name,
  echo: READWISE_READER_MANIFEST.bidirectional_handling,
});
