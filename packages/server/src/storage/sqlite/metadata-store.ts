import { eq } from "drizzle-orm";
import type { Metadata } from "@myme/shared";
import type { MetadataStore } from "../interface.js";
import { metadata } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { rowToMetadata } from "./helpers.js";

export class SqliteMetadataStore implements MetadataStore {
  constructor(private db: DrizzleDb) {}

  get(itemId: string): Metadata {
    const row = this.db
      .select()
      .from(metadata)
      .where(eq(metadata.item_id, itemId))
      .get();
    if (!row) {
      return { item_id: itemId, tags: [], about: [] };
    }
    return rowToMetadata(row);
  }

  set(itemId: string, tags: string[], about: string[]): Metadata {
    this.db
      .update(metadata)
      .set({
        tags: JSON.stringify(tags),
        about: JSON.stringify(about),
      })
      .where(eq(metadata.item_id, itemId))
      .run();
    return { item_id: itemId, tags, about };
  }

  merge(itemId: string, tags?: string[], about?: string[]): Metadata {
    const current = this.get(itemId);
    const mergedTags = tags ? [...new Set([...current.tags, ...tags])] : current.tags;
    const mergedAbout = about ? [...new Set([...current.about, ...about])] : current.about;
    return this.set(itemId, mergedTags, mergedAbout);
  }

  addTags(itemId: string, tags: string[]): Metadata {
    const current = this.get(itemId);
    const merged = [...new Set([...current.tags, ...tags])];
    return this.set(itemId, merged, current.about);
  }

  removeTag(itemId: string, tag: string): Metadata {
    const current = this.get(itemId);
    const filtered = current.tags.filter((t) => t !== tag);
    return this.set(itemId, filtered, current.about);
  }
}
