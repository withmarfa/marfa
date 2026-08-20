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
 * Tokens flow through `ctx.marfa.proxyRequest` against
 * `https://tasks.googleapis.com`; the server stamps the bearer
 * transparently and refreshes on 401.
 *
 * Scope discipline: this integration requests `tasks` only — the
 * narrowest scope that supports both read and write on every task list
 * the user owns. `tasks.readonly` would block outbound; the granular
 * `tasks.write` scope does not exist in Google's catalog.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

/**
 * The two families a connection chooses between, declared once and carried
 * on the manifest itself so the platform validates family coherence
 * centrally and the configure surface derives the chooser.
 */
export const FAMILY_DEFINITIONS: Record<
  "google" | "core",
  { description: string; types: { task: string } }
> = {
  google: {
    description:
      "The Google Tasks type, which keeps the full Tasks field set for an exact round trip.",
    types: { task: "google.tasks.task" },
  },
  core: {
    description:
      "The core task type, readable by any app that understands core tasks; drops Tasks-only fields that type cannot hold.",
    types: { task: "core.task" },
  },
};

export type WriteFamily = keyof typeof FAMILY_DEFINITIONS;

export const DEFAULT_WRITE_FAMILY: WriteFamily = "google";

export const GOOGLE_TASKS_MANIFEST: IntegrationManifest = {
  name: "google.tasks",
  version: "0.2.0",
  manifest_schema_version: "1.3.0",
  configuration_schema: {
    write_family: {
      type: "string",
      description:
        "Item family synced tasks land as. The google family keeps the full Tasks field set; the core family is the cross-app shape other apps read, and drops what that type cannot hold.",
      from_write_families: true,
      default: DEFAULT_WRITE_FAMILY,
    },
    selected_task_list_ids: {
      type: "string_array",
      description:
        "Task lists included in the sync; empty means the default list only.",
    },
    default_write_task_list_id: {
      type: "string",
      description: "Task list that receives tasks created in Marfa.",
    },
  },
  publisher: "google",
  description:
    "Bidirectional sync between Google Tasks and Marfa. Polls every task list under the connected account on a 10-minute schedule and writes Marfa-side mutations back via OAuth proxy.",
  direction: "both",
  runtime_compatibility: ["hosted", "local"],
  // The runtime credential is granted write permission on both families'
  // types so either is reachable at handler time; the install-time
  // configuration chooses which family a connection actually writes.
  target_types: [
    FAMILY_DEFINITIONS.core.types.task,
    FAMILY_DEFINITIONS.google.types.task,
  ],
  write_families: {
    families: FAMILY_DEFINITIONS,
    default: DEFAULT_WRITE_FAMILY,
  },
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
