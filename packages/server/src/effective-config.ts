import { ErrorCode, MarfaError, type InstanceConfig } from "@withmarfa/shared";
import type { AppConfig } from "./config.js";
import { readInstanceConfig } from "./storage/instance-config.js";
import type { SettingsStore } from "./storage/interface.js";

export function hasErrorReceiver(config: AppConfig): boolean {
  return Boolean(
    config.errorWebhookUrl ||
    (config.otel?.posthogHost && config.otel.posthogToken),
  );
}

/** Persisted choices override the environment; addresses and credentials never do. */
export function effectiveConfig(
  config: AppConfig,
  stored: InstanceConfig | null,
) {
  return {
    version_recent_days:
      stored?.version_recent_days ?? config.versionRecentDays,
    version_daily_snapshot_days:
      stored?.version_daily_snapshot_days ?? config.versionDailySnapshotDays,
    version_weekly_snapshot_days:
      stored?.version_weekly_snapshot_days ?? config.versionWeeklySnapshotDays,
    version_max_versions:
      stored?.version_max_versions ?? config.versionMaxVersions,
    grant_inactivity_days:
      stored?.grant_inactivity_days ?? config.grantInactivityDays ?? 365,
    enrichment_enabled:
      stored?.enrichment_enabled ?? config.enrichmentEnabled ?? true,
    enrichment_ocr_enabled:
      stored?.enrichment_ocr_enabled ?? config.enrichmentOcrEnabled ?? true,
    error_reporting_enabled:
      (stored?.error_reporting_enabled ??
        config.errorReportingEnabled ??
        true) &&
      hasErrorReceiver(config),
    heartbeat_enabled:
      (stored?.heartbeat_enabled ?? config.heartbeatEnabled ?? true) &&
      Boolean(config.heartbeatUrl),
  };
}

export async function readEffectiveConfig(
  settings: SettingsStore,
  config: AppConfig,
) {
  return effectiveConfig(config, await readInstanceConfig(settings));
}

/** Validate the merged choices, including the environment values clearing exposes. */
export function validateEffectiveConfig(
  config: AppConfig,
  stored: InstanceConfig,
  requested: {
    heartbeat_enabled?: boolean | null;
    error_reporting_enabled?: boolean | null;
  } = stored,
): void {
  const effective = effectiveConfig(config, stored);
  const errors: { path: string; message: string }[] = [];
  if (effective.version_daily_snapshot_days < effective.version_recent_days)
    errors.push({
      path: "version_daily_snapshot_days",
      message: "must be at least version_recent_days",
    });
  if (
    effective.version_weekly_snapshot_days <
    effective.version_daily_snapshot_days
  )
    errors.push({
      path: "version_weekly_snapshot_days",
      message: "must be at least version_daily_snapshot_days",
    });
  if (requested.heartbeat_enabled && !config.heartbeatUrl)
    errors.push({
      path: "heartbeat_enabled",
      message: "needs a heartbeat receiver configured where Marfa runs",
    });
  if (requested.error_reporting_enabled && !hasErrorReceiver(config))
    errors.push({
      path: "error_reporting_enabled",
      message: "needs an error receiver configured where Marfa runs",
    });
  if (errors.length)
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "The settings cannot be used together",
      { errors },
    );
}
