/**
 * Manifest for the Sync Agent re-presentation.
 *
 * Local-runtime connector. The actual execution is the existing
 * daemon in the mymehq/sync-agent repo — the manifest here exists
 * so that the agent can be installed as a Connection (manifest +
 * Credential + per-Connection runtime extension namespace) instead
 * of running against a free-floating API key in `~/.myme/sync.json`.
 *
 * Triggers: `manual` only. The Cloudflare runtime tier does not
 * dispatch to local connectors; the agent's own filesystem
 * watchers + debounced sync drive execution. Manual trigger
 * exists so the install consent screen can offer a "Run now"
 * affordance the daemon honours via a sentinel.
 *
 * webhook_verification is required by the schema but unused for
 * local connectors — declared as hmac-sha256 by convention.
 */
import type { IntegrationManifest } from "@mymehq/shared";

export const SYNC_AGENT_MANIFEST: IntegrationManifest = {
  name: "mymehq.sync-agent",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "mymehq",
  description:
    "Local file-to-Myme bidirectional sync. Watches configured roots on disk and mirrors them as Myme items.",
  direction: "both",
  runtime_compatibility: ["local"],
  target_types: ["core.note", "core.file"],
  triggers: [{ type: "manual" }],
  bidirectional_handling: {
    echo_ttl_seconds: 30,
    lag_window_seconds: 30,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = SYNC_AGENT_MANIFEST.name;
