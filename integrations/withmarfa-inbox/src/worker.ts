/**
 * Cloudflare Worker entrypoint for the withmarfa.inbox integration.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { WITHMARFA_INBOX_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: WITHMARFA_INBOX_MANIFEST.name,
  echo: WITHMARFA_INBOX_MANIFEST.bidirectional_handling,
});
