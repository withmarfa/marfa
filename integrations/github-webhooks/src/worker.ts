/**
 * Cloudflare Worker entrypoint for the GitHub Webhooks integration.
 */
import { createIntegrationWorker } from "@mymehq/runtime-sdk";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { GITHUB_WEBHOOKS_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: GITHUB_WEBHOOKS_MANIFEST.name,
  echo: GITHUB_WEBHOOKS_MANIFEST.bidirectional_handling,
});
