/**
 * Cloudflare Worker entrypoint for the Podcasts integration.
 *
 * Registers the scheduled sweep, re-exports PerConnectionState for the
 * Durable Object binding, and exports the integration worker.
 *
 * The Podcast Index credential is read here rather than in the handler:
 * handlers receive a connection context, which carries no environment.
 * Only whether both halves are present crosses the boundary — the values
 * themselves stay in the entry.
 */
import { createIntegrationWorker } from "@withmarfa/runtime-sdk/cloudflare";
import { PerConnectionState, registerHandlers } from "./_runtime.js";
import { PODCASTS_MANIFEST } from "./manifest.js";
import { readCredentials } from "./podcast-index.js";

registerHandlers({
  podcastIndexAvailable:
    readCredentials(
      globalThis as {
        PODCASTINDEX_API_KEY?: string;
        PODCASTINDEX_API_SECRET?: string;
      },
    ) !== null,
});

export { PerConnectionState };

export default createIntegrationWorker({
  integrationName: PODCASTS_MANIFEST.name,
  echo: PODCASTS_MANIFEST.bidirectional_handling,
});
