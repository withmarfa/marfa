import type { AppConfig } from "./config.js";
import { readEffectiveConfig } from "./effective-config.js";
import type { SettingsStore } from "./storage/interface.js";

let source: { settings: SettingsStore; config: AppConfig } | undefined;

/** The process-level reporter waits for storage before it can know the durable choice. */
export function bindErrorReporting(
  settings: SettingsStore,
  config: AppConfig,
): void {
  source = { settings, config };
}

export async function errorReportingEnabled(): Promise<boolean> {
  if (!source) return false;
  try {
    return (await readEffectiveConfig(source.settings, source.config))
      .error_reporting_enabled;
  } catch {
    // Unknown permission to send is not permission to send, and reporting
    // a failed read through this reporter would recurse.
    return false;
  }
}
