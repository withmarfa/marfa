/**
 * Manifest for the GitHub Webhooks test integration.
 *
 * Read-only inbound-webhook integration. Listens for `issues` and
 * `pull_request` events on a registered repo. Each opened
 * issue/PR becomes a `core.bookmark` item.
 *
 * HMAC-SHA256 verification via the `github` adapter (server-side
 * verifier in @withmarfa/server inbound-webhooks subsystem).
 *
 * Idempotency is defense-in-depth: the server's
 * `external_delivery_id` UNIQUE constraint catches duplicates
 * that bypass the handler-side check, AND the handler tracks
 * recently-seen `X-GitHub-Delivery` IDs in a bounded ring on the
 * cursor store. Both are intentional.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const GITHUB_WEBHOOKS_MANIFEST: IntegrationManifest = {
  name: "withmarfa.github-webhooks",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "withmarfa",
  description:
    "Receives GitHub webhook deliveries (issues, pull_request) and creates a core.bookmark per opened item.",
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  target_types: ["core.bookmark"],
  triggers: [{ type: "webhook" }],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  webhook_verification: { method: "github" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = GITHUB_WEBHOOKS_MANIFEST.name;
export const DELIVERY_RING_SIZE = 1024;
