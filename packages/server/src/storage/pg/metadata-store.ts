import { eq, inArray } from "drizzle-orm";
import type { Metadata } from "@mymehq/shared";
import type { MetadataStore } from "../interface.js";
import { metadata } from "./schema.js";
import type { PgDb } from "./connection.js";
import { rowToMetadata } from "./helpers.js";

export class PgMetadataStore implements MetadataStore {
  constructor(private db: PgDb) {}

  async getMany(itemIds: string[]): Promise<Metadata[]> {
    if (itemIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(metadata)
      .where(inArray(metadata.item_id, itemIds));
    const map = new Map(rows.map((r) => [r.item_id, rowToMetadata(r)]));
    return itemIds.map(
      (id) =>
        map.get(id) ?? { item_id: id, tags: [], about: [], extensions: {} },
    );
  }

  async get(itemId: string): Promise<Metadata> {
    const [row] = await this.db
      .select()
      .from(metadata)
      .where(eq(metadata.item_id, itemId));
    if (!row) {
      return { item_id: itemId, tags: [], about: [], extensions: {} };
    }
    return rowToMetadata(row);
  }

  async set(
    itemId: string,
    tags: string[],
    about: string[],
  ): Promise<Metadata> {
    await this.db
      .update(metadata)
      .set({
        tags: JSON.stringify(tags),
        about: JSON.stringify(about),
      })
      .where(eq(metadata.item_id, itemId));
    return this.get(itemId);
  }

  async merge(
    itemId: string,
    tags?: string[],
    about?: string[],
  ): Promise<Metadata> {
    const current = await this.get(itemId);
    const mergedTags = tags
      ? [...new Set([...current.tags, ...tags])]
      : current.tags;
    const mergedAbout = about
      ? [...new Set([...current.about, ...about])]
      : current.about;
    return this.set(itemId, mergedTags, mergedAbout);
  }

  async addTags(itemId: string, tags: string[]): Promise<Metadata> {
    const current = await this.get(itemId);
    const merged = [...new Set([...current.tags, ...tags])];
    return this.set(itemId, merged, current.about);
  }

  async removeTag(itemId: string, tag: string): Promise<Metadata> {
    const current = await this.get(itemId);
    const filtered = current.tags.filter((t) => t !== tag);
    return this.set(itemId, filtered, current.about);
  }

  async getExtensions(
    itemId: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const current = await this.get(itemId);
    return current.extensions;
  }

  async setExtension(
    itemId: string,
    namespace: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, Record<string, unknown>>> {
    const current = await this.get(itemId);
    const extensions = { ...current.extensions, [namespace]: data };
    await this.db
      .update(metadata)
      .set({ extensions: JSON.stringify(extensions) })
      .where(eq(metadata.item_id, itemId));
    return extensions;
  }

  async deleteExtension(
    itemId: string,
    namespace: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const current = await this.get(itemId);
    const rest = Object.fromEntries(
      Object.entries(current.extensions).filter(([k]) => k !== namespace),
    );
    await this.db
      .update(metadata)
      .set({ extensions: JSON.stringify(rest) })
      .where(eq(metadata.item_id, itemId));
    return rest;
  }
}
