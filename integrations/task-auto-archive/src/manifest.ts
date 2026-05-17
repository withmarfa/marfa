/**
 * Manifest for the Task Auto-Archive test integration.
 *
 * Reactive intra-Myme connector. Archives `core.task` items older
 * than `archive_after_days` (configuration field, default 30).
 *
 * Two triggers fire the same sweep function:
 *   - `item-event` for responsiveness — any core.task event nudges
 *     the handler (the bridge's self-event suppression keeps the
 *     connector's own writes from re-entering).
 *   - `schedule` (03:00 daily) for guaranteed coverage when no
 *     item events touch the type.
 *
 * `archived` is the lifecycle target (verified against
 * SYSTEM_TRANSITIONS in @mymehq/shared — `active → archived` is
 * allowed for non-system types like core.task).
 */
import type { IntegrationManifest } from "@mymehq/shared";

export const TASK_AUTO_ARCHIVE_MANIFEST: IntegrationManifest = {
  name: "mymehq.task-auto-archive",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "mymehq",
  description:
    "Archives core.task items older than N days (configurable per-install).",
  direction: "write",
  runtime_compatibility: ["hosted", "local"],
  target_types: ["core.task"],
  triggers: [
    { type: "item-event" },
    { type: "schedule", config: { cron: "0 3 * * *" } },
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

export const INTEGRATION_NAME = TASK_AUTO_ARCHIVE_MANIFEST.name;
export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;
