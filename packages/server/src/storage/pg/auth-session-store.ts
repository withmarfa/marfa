import { lt } from "drizzle-orm";
import type { AuthSessionStore } from "../interface.js";
import { auth_session } from "./schema.js";
import type { PgDb } from "./connection.js";

/**
 * Postgres sweep for expired better-auth session rows. Runs against the
 * unwrapped base instance (no RLS) since the `auth_*` tables carry no
 * policies — see the Better Auth bypass note in `app.ts`.
 */
export class PgAuthSessionStore implements AuthSessionStore {
  constructor(private db: PgDb) {}

  async deleteExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(auth_session)
      .where(lt(auth_session.expiresAt, now))
      .returning({ id: auth_session.id });
    return rows.length;
  }
}
