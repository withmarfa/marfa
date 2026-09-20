import { asc } from "drizzle-orm";
import type { OwnerRecord, OwnerStore } from "../interface.js";
import { auth_user } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * The owner, read as the earliest `auth_user` row. See `interface.ts`
 * (`OwnerStore`) for why the row itself is the record.
 */
export class SqliteOwnerStore implements OwnerStore {
  constructor(private db: DrizzleDb) {}

  async find(): Promise<OwnerRecord | null> {
    const rows = await this.db
      .select({
        id: auth_user.id,
        email: auth_user.email,
        name: auth_user.name,
        createdAt: auth_user.createdAt,
      })
      .from(auth_user)
      // The id breaks a tie between two rows stamped in the same instant,
      // so the answer cannot change between reads.
      .orderBy(asc(auth_user.createdAt), asc(auth_user.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
