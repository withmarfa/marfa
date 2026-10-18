import { DisplayNameSchema } from "./display-name.js";
import { readInstanceConfig } from "./storage/instance-config.js";
import type { SettingsStore } from "./storage/interface.js";

export const DEFAULT_INSTANCE_NAME = "Marfa";

export const InstanceNameSchema = DisplayNameSchema.describe(
  "The instance's display name, without control or bidirectional formatting characters. Spaces at each end are trimmed. Absent: `Marfa`.",
);

export async function readInstanceName(
  settings: SettingsStore,
): Promise<string> {
  return (await readInstanceConfig(settings))?.name ?? DEFAULT_INSTANCE_NAME;
}
