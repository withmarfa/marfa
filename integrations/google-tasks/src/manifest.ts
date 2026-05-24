/**
 * Manifest for the Google Tasks bidirectional integration
 * (`google.tasks`).
 *
 * Second instance of the `google.*` publisher family — sibling to
 * `google.calendar`. Same publisher namespace; same OAuth provider
 * credential (reused via `credential_ref` at install time so the
 * stored Web-client config and encrypted secret are shared across
 * every google.* integration).
 *
 * Substrate proof point. Tasks is the simplest Google productivity API:
 *
 *   - No `channels.watch` push notifications; no Pub/Sub. The schedule
 *     trigger is the only inbound rail.
 *   - No `syncToken` either — Tasks uses the `updatedMin` query
 *     parameter as the incremental watermark. Each task list carries
 *     its own watermark in the cursor.
 *   - `bidirectional_handling` mirrors Calendar's defaults so this
 *     ticket also exercises the shared substrate primitives
 *     (echo suppression, lag window, tombstone mapping, partial-write
 *     mode) in a second integration.
 *
 * OAuth uses the proxy mode (`oauth_requirements: { tasks: "proxy" }`).
 * Tokens flow through `ctx.myme.proxyRequest` against
 * `https://tasks.googleapis.com`; the server stamps the bearer
 * transparently and refreshes on 401.
 *
 * Scope discipline: this integration requests `tasks` only — the
 * narrowest scope that supports both read and write on every task list
 * the user owns. `tasks.readonly` would block outbound; the granular
 * `tasks.write` scope does not exist in Google's catalog.
 */
import type { IntegrationManifest } from "@mymehq/shared";

export const GOOGLE_TASKS_MANIFEST: IntegrationManifest = {
  name: "google.tasks",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "google",
  description:
    "Bidirectional sync between Google Tasks and Myme. Polls every task list under the connected account on a 10-minute schedule and writes Myme-side mutations back via OAuth proxy.",
  direction: "both",
  runtime_compatibility: ["hosted", "local"],
  // `google.tasks.task` is the upstream-fidelity type (full Tasks
  // field set, the recommended default). `core.task` is the cross-app
  // shared shape; the runtime credential is granted write permission
  // on both so either is reachable at handler time. The install-time
  // configuration step picks which target type new inbound items land
  // as (default `google.tasks.task` for upstream fidelity;
  // `core.task` for cross-app interop).
  target_types: ["core.task", "google.tasks.task"],
  triggers: [
    { type: "schedule", config: { cron: "*/10 * * * *" } },
    { type: "item-event" },
    // Deliberately NO `webhook` trigger — Tasks API has no
    // channels.watch / Pub/Sub surface for task changes. The schedule
    // is the only inbound rail.
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 120,
    lag_window_seconds: 600,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: { tasks: "proxy" },
  // `webhook_verification` is required by `IntegrationManifestSchema` even
  // though this integration declares no `webhook` trigger. The
  // hmac-sha256 placeholder mirrors what rss-watcher and task-auto-archive
  // (also schedule-only integrations) ship — never read at runtime
  // because no webhook will ever arrive.
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = GOOGLE_TASKS_MANIFEST.name;
export const TASKS_API_BASE = "/tasks/v1";

/**
 * OAuth scopes this integration requests. One scope only — `tasks`
 * covers both read and write across every task list under the
 * connected account. There is no narrower read-write scope; Google
 * does not publish a `tasks.write` scope.
 *
 * Consumed by:
 *   - The OAuth provider credential (`oauth_default_scope` on the
 *     `system.credential` of kind `oauth_token`) reused via
 *     `credential_ref` from the google.calendar install. The shared
 *     credential's default scope is a union of every google.*
 *     integration's recommended scopes.
 *   - The install flow's call to `POST /connections/:id/oauth/start`
 *     which passes `scope: GOOGLE_TASKS_OAUTH_SCOPES_STRING` to the
 *     authorize URL.
 */
export const RECOMMENDED_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/tasks",
] as const;

export const GOOGLE_TASKS_OAUTH_SCOPES_STRING =
  RECOMMENDED_OAUTH_SCOPES.join(" ");

/** Default target type when configuration is absent — upstream-fidelity. */
export const DEFAULT_TARGET_TYPE = "google.tasks.task";
