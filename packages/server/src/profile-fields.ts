import { z } from "@hono/zod-openapi";
import { DisplayNameSchema } from "./display-name.js";

const AvatarSchema = z
  .null()
  .describe(
    "Set `avatar` to `null` to remove the owner's picture, or omit it to leave it unchanged. To set a picture, send its bytes to `PUT /owner/picture` or `PUT /profile/picture`.",
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
