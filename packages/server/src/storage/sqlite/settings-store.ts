import { eq } from "drizzle-orm";
import type { SettingsStore } from "../interface.js";
import { settings } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteSettingsStore implements SettingsStore {
  constructor(private db: DrizzleDb) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  async claim(key: string, value: string): Promise<boolean> {
    // INSERT ... ON CONFLICT DO NOTHING RETURNING — better-sqlite3 returns
    // the inserted rows, or an empty array on conflict. The winner of the
    // first concurrent insert sees length === 1; everyone else sees 0.
    const rows = await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoNothing()
      .returning({ key: settings.key })
      .all();
    return rows.length > 0;
  }

  async release(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}
