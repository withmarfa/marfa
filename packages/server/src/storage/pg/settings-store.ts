import { eq, sql } from "drizzle-orm";
import type { SettingsStore } from "../interface.js";
import { settings } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgSettingsStore implements SettingsStore {
  constructor(private db: PgDb) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key));
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`EXCLUDED.value` },
      });
  }

  async claim(key: string, value: string): Promise<boolean> {
    // INSERT ... ON CONFLICT DO NOTHING RETURNING — postgres-js returns the
    // inserted rows, or an empty array on conflict. Atomic claim under
    // concurrent inserts (T-007).
    const rows = await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    return rows.length > 0;
  }
}
