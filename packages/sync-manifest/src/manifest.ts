/**
 * Manifest for the sync client's re-presentation as a Connection.
 *
 * Sync is a client: the items it writes belong to the user and are
 * editable like anything the user creates — they are not mirrors, and
 * nothing re-syncs over an edit. Installing it as a Connection is
 * plumbing, not identity: it gets credentials, configuration, and
 * observability the same way integrations do.
 *
 * The execution is the daemon in the withmarfa/sync repo (npm:
 * `@withmarfa/sync`), which watches a filesystem and therefore can only
 * run on the user's machine. The manifest here exists so that the client
 * can be installed as a Connection (manifest + Credential + per-Connection
 * runtime extension namespace) instead of running against a free-floating
 * API key in `~/.marfa/sync.json`.
 *
 * **Where the code has to run is what decides what something is**, which
 * is why this lives in `packages/` rather than beside the integrations. An
 * integration is something a deployment installs into the runtime's
 * directory; a client is something the platform knows about. So this
 * manifest ships with the server build, as an ordinary workspace
 * dependency handed to the boot-time catalog reconcile, rather than being
 * discovered under `MARFA_INTEGRATIONS_ROOT`.
 *
 * Triggers: `manual` only, and it is vestigial. Marfa's runtime dispatches
 * sync never; the daemon's own filesystem watchers and debounced sweeps
 * drive it. `POST /connections/{id}/run` refuses it for exactly that
 * reason, naming where it actually runs. The trigger survives only because
 * the manifest schema requires at least one and no trigger kind honestly
 * describes "started by a program somewhere else".
 *
 * `webhook_verification` is required by the schema and unused here —
 * declared as hmac-sha256 by convention.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const SYNC_MANIFEST: IntegrationManifest = {
  name: "marfa/sync",
  version: "0.2.0",
  manifest_schema_version: "2.0.0",
  publisher: "withmarfa",
  description:
    "Local file-sync client. Watches configured roots on disk; the items it writes belong to you and are editable like anything you create. Installs as a connection so it gets credentials, configuration, and observability the same way integrations do.",
  direction: "both",
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
