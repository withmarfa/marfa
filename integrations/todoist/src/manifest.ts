/**
 * Manifest for the Todoist bidirectional integration (`todoist`).
 *
 * Uses the token-credential install seam.
 * `token_requirements: { todoist: "required" }` declares the
 * dependency on a `system.credential` of kind `api_token` whose
 * `api_token_config.upstream_base_url` is `https://api.todoist.com`.
 * The user's Todoist API token is encrypted into `secret_encrypted`
 * at install time via `POST /credentials/api-token`; the proxy stamps
 * it transparently on every upstream call.
 *
 * Both inbound (poll Sync API → upsert Marfa items) and outbound
 * (item-event on the target type → push to Todoist via REST + Sync
 * commands) are wired through one connector:
 *
 *   - **Inbound** — `POST /api/v1/sync` with `sync_token` (opaque
 *     watermark, `"*"` sentinel on first run). Body is the full
 *     incremental delta of items + temp_id_mapping for any commands
 *     issued. Cursor persists `sync_token` for the next call.
 *   - **Outbound create** — `POST /api/v1/sync` with one `item_add`
 *     command carrying `temp_id = SHA-256("marfa:<item.id>")` and a
 *     deterministic `uuid` for command-level idempotency. The Sync
 *     response's `temp_id_mapping` resolves the server-side id.
 *   - **Outbound update** — `POST /api/v1/tasks/{id}` (REST). Simpler
 *     than the Sync `item_update` command for singletons.
 *   - **Outbound complete (trash)** — `POST /api/v1/tasks/{id}/close`
 *     (REST). One-shot; no body.
 *
 * Webhooks are deferred. Todoist supports outbound webhooks but they
 * require a publicly-reachable URL — not in scope for this round.
 * The schedule trigger is the only inbound rail.
 *
 * `bidirectional_handling` mirrors Calendar's defaults (echo TTL 120s,
 * lag window 600s, state-trashed tombstones, accept-partial writes) —
 * the substrate primitives behave identically across upstreams.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const TODOIST_MANIFEST: IntegrationManifest = {
  name: "todoist.tasks",
  version: "0.1.0",
  manifest_schema_version: "1.1.0",
  publisher: "todoist",
  description:
    "Bidirectional sync between Todoist and Marfa. Polls Todoist's Sync API for incremental task changes on a 10-minute schedule and writes Marfa-side mutations back via the REST API + Sync commands.",
  direction: "both",
  runtime_compatibility: ["hosted", "local"],
  // `todoist.task` is the upstream-fidelity type (full Todoist field
  // set, the recommended default). `core.task` is the cross-app shared
  // shape; the runtime credential is granted write permission on both
  // so either is reachable at handler time. New inbound items land as
  // `todoist.task` by default.
  target_types: ["core.task", "todoist.task"],
  triggers: [
    { type: "schedule", config: { cron: "*/10 * * * *" } },
    { type: "item-event" },
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 120,
    lag_window_seconds: 600,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  token_requirements: { todoist: "required" },
  // `webhook_verification` is required by `IntegrationManifestSchema`
  // even when no `webhook` trigger is declared. The hmac-sha256
  // placeholder mirrors what google-tasks (also no-webhook) ships;
  // it's never read at runtime because no webhook arrives.
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = TODOIST_MANIFEST.name;

/** Sentinel passed as `sync_token` on the first incremental sync. */
export const SYNC_TOKEN_INITIAL = "*";

/** Resource types we ask for on every Sync call. Items only — projects
 *  / labels / sections aren't materialised as Marfa items in this
 *  iteration. */
export const SYNC_RESOURCE_TYPES = ["items"] as const;

/** Default target type for inbound items when configuration is absent. */
export const DEFAULT_TARGET_TYPE = "todoist.task";
