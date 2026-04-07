import { eq } from "drizzle-orm";
import type { Metadata } from "@mymehq/shared";
import type { LocalDb } from "../connection.js";
import { metadata } from "../schema.js";
import { rowToMetadata } from "../helpers.js";

export class LocalMetadataStore {
  constructor(private db: LocalDb) {}

  get(itemId: string): Metadata | null {
    const row = this.db
      .select()
      .from(metadata)
      .where(eq(metadata.item_id, itemId))
      .get();
    if (!row) return null;
    return rowToMetadata(row as unknown as Record<string, unknown>);
  }

  /** Upsert metadata from Electric sync. */
  upsert(meta: Metadata): void {
    this.db
      .insert(metadata)
      .values({
        item_id: meta.item_id,
        tags: JSON.stringify(meta.tags),
        about: JSON.stringify(meta.about),
      })
      .onConflictDoUpdate({
        target: metadata.item_id,
        set: {
          tags: JSON.stringify(meta.tags),
          about: JSON.stringify(meta.about),
        },
      })
      .run();
  }

  remove(itemId: string): void {
    this.db.delete(metadata).where(eq(metadata.item_id, itemId)).run();
  }
}
