import { z } from "zod";

/** The closed profile surface: only the owner can change the sign-in address. */
export const ProfilePermissionsSchema = z.strictObject({
  "*": z
    .enum(["read", "write"])
    .optional()
    .describe(
      "Access to every profile field. write changes only name and avatar.",
    ),
  name: z
    .enum(["read", "write"])
    .optional()
    .describe("Access to the owner's name."),
  email: z
    .literal("read")
    .optional()
    .describe("Read access to the owner's email address."),
  avatar: z
    .enum(["read", "write"])
    .optional()
    .describe("Access to the owner's avatar URL."),
});
