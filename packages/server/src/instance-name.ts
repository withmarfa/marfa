import { z } from "@hono/zod-openapi";
import { UNPRINTABLE } from "./auth/sign-in-names.js";
import { readInstanceConfig } from "./storage/instance-config.js";
import type { SettingsStore } from "./storage/interface.js";

export const DEFAULT_INSTANCE_NAME = "Marfa";

export const InstanceNameSchema = z
  .string()
  .refine(
    (name) => !UNPRINTABLE.test(name) && !/\p{Bidi_Control}/u.test(name),
    {
      message:
        "name can't hold a control or bidirectional formatting character",
    },
  )
  .trim()
  .min(1)
  .max(200)
  .describe(
    "The instance's display name, without control or bidirectional formatting characters. Spaces at each end are trimmed. Absent: `Marfa`.",
  );

export async function readInstanceName(
  settings: SettingsStore,
): Promise<string> {
  return (await readInstanceConfig(settings))?.name ?? DEFAULT_INSTANCE_NAME;
}
