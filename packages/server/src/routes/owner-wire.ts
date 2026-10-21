import { z } from "@hono/zod-openapi";
import type { OwnerRecord } from "../storage/interface.js";

export const OwnerSchema = z
  .object({
    id: z.string().describe("Unique identifier for the owner."),
    email: z.string().describe("Email address used to sign in."),
    name: z.string().describe("Display name of the owner."),
    avatar: z
      .string()
      .nullable()
      .describe("The owner's picture URL, or `null` when none is set."),
    created_at: z.string().describe("When the owner was created, in UTC."),
  })
  .describe("The single owner of the instance.")
  .openapi("Owner");

/** The owner as every claim answer carries it. */
export function ownerWire(owner: OwnerRecord): z.infer<typeof OwnerSchema> {
  return {
    id: owner.id,
    email: owner.email,
    name: owner.name,
    avatar: owner.avatar,
    created_at: owner.createdAt.toISOString(),
  };
}
