/**
 * Cloudflare Worker entrypoint for the withmarfa.inbox integration.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { MYMEHQ_INBOX_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: MYMEHQ_INBOX_MANIFEST.name,
  echo: MYMEHQ_INBOX_MANIFEST.bidirectional_handling,
});
