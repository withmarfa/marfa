import type { SpaceConfig } from "@withmarfa/shared";
import type { SettingsStore } from "./interface.js";
import { safeJsonParse } from "./json-utils.js";

/** The settings key the instance configuration is held under. */
export const SPACE_CONFIG_KEY = "space_config";

/** The instance configuration `GET/PUT /spaces/me/config` reads and writes,
 *  or `null` when nothing has been written. */
export async function readSpaceConfig(
  settings: SettingsStore,
): Promise<SpaceConfig | null> {
  const raw = await settings.get(SPACE_CONFIG_KEY);
  if (raw === null) return null;
  return safeJsonParse<SpaceConfig>(raw, {}, "instance config");
}

export function writeSpaceConfig(
  settings: SettingsStore,
  config: SpaceConfig,
): Promise<void> {
  return settings.set(SPACE_CONFIG_KEY, JSON.stringify(config));
}
