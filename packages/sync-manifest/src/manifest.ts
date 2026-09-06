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
 * is why this lives in `packages/` rather than beside the integrations. It
 * ships with the server build, as an ordinary workspace dependency handed
 * to the boot-time catalog reconcile, rather than being discovered under
 * `MARFA_INTEGRATIONS_ROOT` — a deployment can add an integration without
 * rebuilding and cannot add a client at all.
 *
 * The manifest says so itself now. `runs_on: "client"` is what the run
 * route reads before it looks at anything else, so a refusal names where
 * the code runs rather than inferring it from a missing registration. A
 * client-run manifest declares no triggers, because nothing on this side
 * fires one.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

// Annotated with the literal rather than the bare type, because
// `CLIENT_MANIFESTS` accepts only a client-run manifest. The narrowing is
// the whole point: a client manifest that forgot the field should not
// compile.
export const SYNC_MANIFEST: IntegrationManifest & { runs_on: "client" } = {
  name: "marfa/sync",
  version: "0.4.0",
  manifest_schema_version: "2.2.0",
  publisher: "marfa",
  description:
    "Local file-sync client. Watches configured roots on disk; the items it writes belong to you and are editable like anything you create. Installs as a connection so it gets credentials, configuration, and observability the same way integrations do.",
  direction: "both",
  runs_on: "client",
  target_types: ["core.note", "core.file"],
  bidirectional_handling: {
    echo_ttl_seconds: 30,
    lag_window_seconds: 30,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  permissions: {
    extension: { "connection.runtime": "write" },
  },
};
