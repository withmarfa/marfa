import { createIntegrationWorker } from "@mymehq/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { RAINDROP_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: RAINDROP_MANIFEST.name,
  echo: RAINDROP_MANIFEST.bidirectional_handling,
});
