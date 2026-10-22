import { z } from "@hono/zod-openapi";
import { ownerPictureAddress } from "../picture.js";
import type { OwnerRecord } from "../storage/interface.js";

export const OwnerSchema = z
  .object({
    id: z.string().describe("Unique identifier for the owner."),
    email: z.string().describe("Email address used to sign in."),
    name: z.string().describe("Display name of the owner."),
    avatar: z
      .string()
      .nullable()
      .describe(
        "The address of the owner's picture on this instance, or `null` when none is set. Fetch it with `GET /owner/picture`.",
      ),
    created_at: z.string().describe("When the owner was created, in UTC."),
  })
  .describe("The single owner of the instance.")
  .openapi("Owner");

/** The owner as every claim answer carries it. */
export function ownerWire(
  owner: OwnerRecord,
  authBaseUrl: string,
): z.infer<typeof OwnerSchema> {
  return {
    id: owner.id,
    email: owner.email,
    name: owner.name,
    avatar: owner.hasPicture ? ownerPictureAddress(authBaseUrl) : null,
    created_at: owner.createdAt.toISOString(),
  };
}
