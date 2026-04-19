import { eq } from "drizzle-orm";
import type { SettingsStore } from "../interface.js";
import { settings } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteSettingsStore implements SettingsStore {
  constructor(private db: DrizzleDb) {}

  get(key: string): Promise<string | null> {
    const row = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    return Promise.resolve(row?.value ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    return Promise.resolve();
  }
}
