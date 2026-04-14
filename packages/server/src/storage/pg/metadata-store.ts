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
      (id) => map.get(id) ?? { item_id: id, tags: [], extensions: {} },
    );
  }

  async get(itemId: string): Promise<Metadata> {
    const [row] = await this.db
      .select()
      .from(metadata)
      .where(eq(metadata.item_id, itemId));
    if (!row) {
      return { item_id: itemId, tags: [], extensions: {} };
    }
    return rowToMetadata(row);
  }

  async set(itemId: string, tags: string[]): Promise<Metadata> {
    await this.db
      .update(metadata)
      .set({ tags: JSON.stringify(tags) })
      .where(eq(metadata.item_id, itemId));
    return this.get(itemId);
  }

  async merge(itemId: string, tags?: string[]): Promise<Metadata> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId));
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const mergedTags = tags
        ? [...new Set([...current.tags, ...tags])]
        : current.tags;
      await tx
        .update(metadata)
        .set({ tags: JSON.stringify(mergedTags) })
        .where(eq(metadata.item_id, itemId));
      return { ...current, tags: mergedTags };
    });
  }

  async addTags(itemId: string, tags: string[]): Promise<Metadata> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId));
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const merged = [...new Set([...current.tags, ...tags])];
      await tx
        .update(metadata)
        .set({ tags: JSON.stringify(merged) })
        .where(eq(metadata.item_id, itemId));
      return { ...current, tags: merged };
    });
  }

  async removeTag(itemId: string, tag: string): Promise<Metadata> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId));
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const filtered = current.tags.filter((t) => t !== tag);
      await tx
        .update(metadata)
        .set({ tags: JSON.stringify(filtered) })
        .where(eq(metadata.item_id, itemId));
      return { ...current, tags: filtered };
    });
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
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId));
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const extensions = { ...current.extensions, [namespace]: data };
      await tx
        .update(metadata)
        .set({ extensions: JSON.stringify(extensions) })
        .where(eq(metadata.item_id, itemId));
      return extensions;
    });
  }

  async deleteExtension(
    itemId: string,
    namespace: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId));
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const rest = Object.fromEntries(
        Object.entries(current.extensions).filter(([k]) => k !== namespace),
      );
      await tx
        .update(metadata)
        .set({ extensions: JSON.stringify(rest) })
        .where(eq(metadata.item_id, itemId));
      return rest;
    });
  }
}
