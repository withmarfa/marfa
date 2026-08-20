/**
 * Manifest for the Task Auto-Archive test integration.
 *
 * Reactive intra-Marfa integration. Archives `core.task` items older
 * than `archive_after_days` (configuration field, default 30).
 *
 * Two triggers fire the same sweep function:
 *   - `item-event` for responsiveness — any core.task event nudges
 *     the handler (the bridge's self-event suppression keeps the
 *     integration's own writes from re-entering).
 *   - `schedule` (03:00 daily) for guaranteed coverage when no
 *     item events touch the type.
 *
 * `archived` is the lifecycle target (verified against
 * SYSTEM_TRANSITIONS in @withmarfa/shared — `active → archived` is
 * allowed for non-system types like core.task).
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;

export const TASK_AUTO_ARCHIVE_MANIFEST: IntegrationManifest = {
  name: "withmarfa.task-auto-archive",
  version: "0.1.0",
  manifest_schema_version: "1.2.0",
  configuration_schema: {
    archive_after_days: {
      type: "number",
      description:
        "Age in days, measured from an item's server-stamped creation time, past which a task is archived.",
      default: DEFAULT_ARCHIVE_AFTER_DAYS,
    },
  },
  publisher: "withmarfa",
  description:
    "Archives core.task items older than N days (configurable per-install).",
  direction: "write",
  runtime_compatibility: ["local"],
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
