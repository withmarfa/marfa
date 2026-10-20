import { z } from "@hono/zod-openapi";
import { hasHiddenCharacter } from "./auth/sign-in-names.js";

export const DisplayNameSchema = z
  .string()
  .refine((name) => !hasHiddenCharacter(name), {
    message: "name can't hold a control or bidirectional formatting character",
  })
  .trim()
  .min(1)
  .max(200)
  .describe(
    "Display name, without control or bidirectional formatting characters. Spaces at each end are trimmed.",
  );
