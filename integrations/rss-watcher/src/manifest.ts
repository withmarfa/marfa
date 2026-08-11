/**
 * Manifest for the RSS Watcher test integration.
 *
 * Typed against `IntegrationManifestSchema` from @withmarfa/shared so a
 * schema drift in the contract surfaces here at compile time. The
 * schema-validation test in `manifest.test.ts` parses the constant
 * through the Zod schema at runtime — belt-and-braces.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const RSS_WATCHER_MANIFEST: IntegrationManifest = {
  name: "withmarfa.rss-watcher",
  version: "0.1.0",
  manifest_schema_version: "1.2.0",
  configuration_schema: {
    feed_url: {
      type: "string",
      description: "The Atom or RSS feed to poll.",
      required: true,
    },
  },
  publisher: "withmarfa",
  description:
    "Polls an Atom 1.0 or RSS 2.0 feed on a schedule and creates a core.bookmark per new entry. Read-only.",
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  target_types: ["core.bookmark"],
  triggers: [
    {
      type: "schedule",
      config: { cron: "0 * * * *" },
    },
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = RSS_WATCHER_MANIFEST.name;
