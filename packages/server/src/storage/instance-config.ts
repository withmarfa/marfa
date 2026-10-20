import type { InstanceConfig } from "@withmarfa/shared";
import type { SettingsStore } from "./interface.js";
import { safeJsonParse } from "./json-utils.js";

/** The settings key the instance configuration is held under. */
export const INSTANCE_CONFIG_KEY = "instance_config";

/** The instance configuration `GET/PUT /config` reads and writes,
 *  or `null` when nothing has been written. */
export async function readInstanceConfig(
  settings: SettingsStore,
): Promise<InstanceConfig | null> {
  const raw = await settings.get(INSTANCE_CONFIG_KEY);
  if (raw === null) return null;
  return safeJsonParse<InstanceConfig>(raw, {}, "instance config");
}

/**
 * The stored configuration with `changes` applied: a setting named is
 * replaced whole, a setting named `null` is removed, and every other setting
 * stays as it was.
 */
export function mergeInstanceConfig(
  stored: InstanceConfig | null,
  changes: { [K in keyof InstanceConfig]?: InstanceConfig[K] | null },
): InstanceConfig {
  const merged: Record<string, unknown> = { ...stored };
  for (const [setting, value] of Object.entries(changes)) {
    if (value === null) delete merged[setting];
    else if (value !== undefined) merged[setting] = value;
  }
  return merged as InstanceConfig;
}

export function writeInstanceConfig(
  settings: SettingsStore,
  config: InstanceConfig,
): Promise<void> {
  return settings.set(INSTANCE_CONFIG_KEY, JSON.stringify(config));
}
