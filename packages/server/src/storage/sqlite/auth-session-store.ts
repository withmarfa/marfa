import { lt } from "drizzle-orm";
import type { AuthSessionStore } from "../interface.js";
import { auth_session } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * SQLite sweep for expired better-auth session rows — instance-wide.
 */
export class SqliteAuthSessionStore implements AuthSessionStore {
  constructor(private db: DrizzleDb) {}

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db
      .delete(auth_session)
      .where(lt(auth_session.expiresAt, now))
      .run();
    return result.rowsAffected;
  }
}
