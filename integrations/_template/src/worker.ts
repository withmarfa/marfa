/**
 * Cloudflare Worker entrypoint for the template Integration.
 *
 * Wiring shape, which every integration copies:
 *   1. Register the handlers at module load.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Export a default `{ fetch, queue }` built from the SDK helper.
 *
 * The `fetch` surface a Worker built this way exposes requires the
 * runtime broker key, and answers an unknown path with 404. Both come
 * from the helper, so a hand-rolled handler here would hand every
 * integration started from this scaffold an unauthenticated HTTP
 * surface and nothing to notice it by. `integrations/AGENTS.md` covers
 * the contract, including how to gate a surface built outside this
 * entry point.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { TEMPLATE_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: TEMPLATE_MANIFEST.name,
  echo: TEMPLATE_MANIFEST.bidirectional_handling,
});
