/**
 * Cloudflare Worker entrypoint for the Todoist integration.
 *
 * Same shape as the other in-tree integrations: register handlers at
 * module load, re-export `PerConnectionState` so the DO binding
 * resolves, export the default `{ fetch, queue, scheduled }` built
 * from the runtime-sdk helper. The helper consumes the two queue
 * families declared in `wrangler.toml` and dispatches by manifest
 * name.
 */
import { createIntegrationWorker } from "@mymehq/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { TODOIST_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: TODOIST_MANIFEST.name,
  echo: TODOIST_MANIFEST.bidirectional_handling,
});
