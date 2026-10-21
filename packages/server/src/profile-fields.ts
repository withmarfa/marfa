import { z } from "@hono/zod-openapi";
import { DisplayNameSchema } from "./display-name.js";

const AvatarSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .nullable()
  .describe(
    "HTTP or HTTPS avatar URL, at most 2048 characters. null clears it. Marfa does not fetch the URL.",
  );

export const OwnerUpdateSchema = z
  .strictObject({
    email: z
      .email()
      .max(254)
      .transform((email) => email.toLowerCase())
      .optional()
      .describe(
        "Email address used to sign in. Stored in lowercase; changing it clears email verification.",
      ),
    name: DisplayNameSchema.optional(),
    avatar: AvatarSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide email, name, or avatar",
  });

export const ProfileUpdateSchema = z
  .strictObject({
    name: DisplayNameSchema.optional(),
    avatar: AvatarSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide name or avatar",
  });
