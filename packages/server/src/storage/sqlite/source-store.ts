import { eq } from "drizzle-orm";
import * as clock from "../../clock.js";
import type { SourceNaming, SourceStore } from "../interface.js";
import type { DrizzleDb } from "./connection.js";
import { sourceNames } from "./schema.js";

function naming(row: typeof sourceNames.$inferSelect): SourceNaming {
  return {
    source: row.source,
    name: row.name ?? null,
    mark: row.mark ?? null,
  };
}

export class SqliteSourceStore implements SourceStore {
  constructor(private db: DrizzleDb) {}

  async list(): Promise<SourceNaming[]> {
    const rows = await this.db.select().from(sourceNames).all();
    return rows.map(naming);
  }

  async get(source: string): Promise<SourceNaming | null> {
    const row = await this.db
      .select()
      .from(sourceNames)
      .where(eq(sourceNames.source, source))
      .get();
    return row ? naming(row) : null;
  }

  async set(
    source: string,
    name: string | null,
    mark: string | null,
  ): Promise<void> {
    if (name === null && mark === null) {
      await this.db
        .delete(sourceNames)
        .where(eq(sourceNames.source, source))
        .run();
      return;
    }
    const updated_at = clock.now().toISOString();
    await this.db
      .insert(sourceNames)
      .values({ source, name, mark, updated_at })
      .onConflictDoUpdate({
        target: sourceNames.source,
        set: { name, mark, updated_at },
      })
      .run();
  }
}
