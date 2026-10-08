import { eq } from "drizzle-orm";
import type { OwnerRecord, OwnerStore } from "../interface.js";
import { auth_user, settings } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteOwnerStore implements OwnerStore {
  constructor(private db: DrizzleDb) {}

  async find(): Promise<OwnerRecord | null> {
    const claim = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "instance.claim"))
      .get();
    if (!claim) return null;
    const state = JSON.parse(claim.value) as {
      claimed: boolean;
      ownerId: string | null;
    };
    if (!state.claimed || !state.ownerId) return null;
    const rows = await this.db
      .select({
        id: auth_user.id,
        email: auth_user.email,
        name: auth_user.name,
        createdAt: auth_user.createdAt,
      })
      .from(auth_user)
      .where(eq(auth_user.id, state.ownerId))
      .limit(1);
    return rows[0] ?? null;
  }
}
