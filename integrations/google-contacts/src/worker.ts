/**
 * Cloudflare Worker entrypoint for the Google Contacts integration.
 *
 * Wiring shape (mirrors the other google.* integrations):
 *   1. Register schedule + item-event handlers at module load.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Export a default `{ fetch, queue, scheduled }` built from the SDK
 *      helper. Two queue families: scheduled-poll + reactive-run.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { GOOGLE_CONTACTS_MANIFEST } from "./manifest.js";

registerHandlers();

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: GOOGLE_CONTACTS_MANIFEST.name,
  echo: GOOGLE_CONTACTS_MANIFEST.bidirectional_handling,
});
