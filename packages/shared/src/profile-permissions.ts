import type { ProfilePermission } from "./types.js";
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

/** Only effective authority can pass to a newly minted credential. */
export function delegableProfilePermissions(
  perms: Readonly<Record<string, ProfilePermission>> | undefined,
): Record<string, ProfilePermission> {
  const result: Record<string, ProfilePermission> = {};
  for (const field of Object.keys(ProfilePermissionsSchema.shape)) {
    const level = perms?.[field];
    if (level === "read" || level === "write")
      result[field] = field === "email" ? "read" : level;
  }
  return result;
}
