import type { OwnerRecord } from "../storage/interface.js";

/** The owner as every claim answer carries it. */
export function ownerWire(owner: OwnerRecord) {
  return {
    id: owner.id,
    email: owner.email,
    name: owner.name,
    created_at: owner.createdAt.toISOString(),
  };
}
