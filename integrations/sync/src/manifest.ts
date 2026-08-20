/**
 * Manifest for the sync client's re-presentation as a Connection.
 *
 * Sync is a client: the items it writes belong to the user and are
 * editable like anything the user creates — they are not mirrors, and
 * nothing re-syncs over an edit. Installing it as a Connection is
 * plumbing, not identity: it gets credentials, configuration, and
 * observability the same way integrations do.
 *
 * Local-runtime integration. The actual execution is the existing
 * daemon in the withmarfa/sync repo (npm: @withmarfa/sync) — the manifest
 * here exists so that the client can be installed as a Connection
 * (manifest + Credential + per-Connection runtime extension namespace)
 * instead of running against a free-floating API key in
 * `~/.marfa/sync.json`.
 *
 * Triggers: `manual` only. The Cloudflare runtime tier does not
 * dispatch to local integrations; the agent's own filesystem
 * watchers + debounced sync drive execution. Manual trigger
 * exists so the install consent screen can offer a "Run now"
 * affordance the daemon honors via a sentinel.
 *
 * webhook_verification is required by the schema but unused for
 * local integrations — declared as hmac-sha256 by convention.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const SYNC_MANIFEST: IntegrationManifest = {
  name: "marfa/sync",
  version: "0.1.1",
  manifest_schema_version: "1.0.0",
  publisher: "withmarfa",
  description:
    "Local file-sync client. Watches configured roots on disk; the items it writes belong to you and are editable like anything you create. Installs as a connection so it gets credentials, configuration, and observability the same way integrations do.",
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

export const INTEGRATION_NAME = SYNC_MANIFEST.name;
