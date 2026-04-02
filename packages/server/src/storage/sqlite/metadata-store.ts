import { eq } from "drizzle-orm";
import type { Metadata } from "@myme/shared";
import type { MetadataStore } from "../interface.js";
import { metadata } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { rowToMetadata } from "./helpers.js";

export class SqliteMetadataStore implements MetadataStore {
  constructor(private db: DrizzleDb) {}

  get(itemId: string): Promise<Metadata> {
    const row = this.db
      .select()
      .from(metadata)
      .where(eq(metadata.item_id, itemId))
      .get();
    if (!row) {
      return Promise.resolve({
        item_id: itemId,
        tags: [],
        about: [],
        extensions: {},
      });
    }
    return Promise.resolve(rowToMetadata(row));
  }

  set(itemId: string, tags: string[], about: string[]): Promise<Metadata> {
    this.db
      .update(metadata)
      .set({
        tags: JSON.stringify(tags),
        about: JSON.stringify(about),
      })
      .where(eq(metadata.item_id, itemId))
      .run();
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
    this.db
      .update(metadata)
      .set({ extensions: JSON.stringify(extensions) })
      .where(eq(metadata.item_id, itemId))
      .run();
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
    this.db
      .update(metadata)
      .set({ extensions: JSON.stringify(rest) })
      .where(eq(metadata.item_id, itemId))
      .run();
    return rest;
  }
}
