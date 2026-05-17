/**
 * Cloudflare Worker entrypoint for the RSS Watcher integration.
 *
 * Wiring shape:
 *   1. Register the schedule handler at module load.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Export a default `{ fetch, queue }` built from the SDK helper.
 */
import { createIntegrationWorker } from "@mymehq/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { RSS_WATCHER_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: RSS_WATCHER_MANIFEST.name,
  echo: RSS_WATCHER_MANIFEST.bidirectional_handling,
});
