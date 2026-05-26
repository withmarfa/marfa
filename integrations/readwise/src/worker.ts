/**
 * Cloudflare Worker entrypoint for the Readwise integration.
 * Registers the inbound schedule handler; re-exports PerConnectionState
 * for the DO binding; exports the integration-worker default.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { READWISE_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: READWISE_MANIFEST.name,
  echo: READWISE_MANIFEST.bidirectional_handling,
});
