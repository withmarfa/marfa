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
  name: "marfa/rss-watcher",
  // Moved to 0.3.0 for the `manual` trigger below. Registration keys on
  // (name, version), so a manifest that changes without moving its version
  // cannot be registered: it collides with the stale row it is meant to
  // replace, and the catalog keeps answering for a capability the build
  // has. That happened once here, with `supports_user_mappings` at 0.1.0,
  // and a committed manifest lock now refuses it before merge.
  version: "0.3.0",
  manifest_schema_version: "1.3.0",
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
  runtime_compatibility: ["local"],
  target_types: ["core.bookmark"],
  supports_user_mappings: true,
  triggers: [
    {
      type: "schedule",
      config: { cron: "0 * * * *" },
    },
    // Its sweep is cheap and idempotent, so there is no reason to make
    // somebody wait an hour to see a feed change land.
    { type: "manual" },
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
