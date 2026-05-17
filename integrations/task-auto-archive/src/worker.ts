/**
 * Cloudflare Worker entrypoint for the Task Auto-Archive integration.
 */
import { createIntegrationWorker } from "@mymehq/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { TASK_AUTO_ARCHIVE_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: TASK_AUTO_ARCHIVE_MANIFEST.name,
  echo: TASK_AUTO_ARCHIVE_MANIFEST.bidirectional_handling,
});
