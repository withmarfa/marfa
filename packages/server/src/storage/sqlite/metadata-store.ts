/* eslint-disable @typescript-eslint/no-non-null-assertion -- transaction guarantees row exists after insert */
import { eq, inArray } from "drizzle-orm";
import type { Metadata } from "@mymehq/shared";
import type { MetadataStore } from "../interface.js";
import { metadata } from "./schema.js";
import type { DrizzleDb, RawDb } from "./connection.js";
import { rowToMetadata } from "./helpers.js";

export class SqliteMetadataStore implements MetadataStore {
  constructor(
    private db: DrizzleDb,
    private raw: RawDb,
  ) {}

  getMany(itemIds: string[]): Promise<Metadata[]> {
    if (itemIds.length === 0) return Promise.resolve([]);
    const rows = this.db
      .select()
      .from(metadata)
      .where(inArray(metadata.item_id, itemIds))
      .all();
    const map = new Map(rows.map((r) => [r.item_id, rowToMetadata(r)]));
    return Promise.resolve(
      itemIds.map(
        (id) =>
          map.get(id) ?? { item_id: id, tags: [], about: [], extensions: {} },
      ),
    );
  }

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
    const mergeFn = this.raw.transaction(() => {
      const row = this.db
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], about: [], extensions: {} };
      const mergedTags = tags
        ? [...new Set([...current.tags, ...tags])]
        : current.tags;
      const mergedAbout = about
        ? [...new Set([...current.about, ...about])]
        : current.about;
      this.db
        .update(metadata)
        .set({
          tags: JSON.stringify(mergedTags),
          about: JSON.stringify(mergedAbout),
        })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rowToMetadata(
        this.db
          .select()
          .from(metadata)
          .where(eq(metadata.item_id, itemId))
          .get()!,
      );
    });
    return mergeFn();
  }

  async addTags(itemId: string, tags: string[]): Promise<Metadata> {
    const addFn = this.raw.transaction(() => {
      const row = this.db
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], about: [], extensions: {} };
      const merged = [...new Set([...current.tags, ...tags])];
      this.db
        .update(metadata)
        .set({
          tags: JSON.stringify(merged),
          about: JSON.stringify(current.about),
        })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rowToMetadata(
        this.db
          .select()
          .from(metadata)
          .where(eq(metadata.item_id, itemId))
          .get()!,
      );
    });
    return addFn();
  }

  async removeTag(itemId: string, tag: string): Promise<Metadata> {
    const removeFn = this.raw.transaction(() => {
      const row = this.db
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], about: [], extensions: {} };
      const filtered = current.tags.filter((t) => t !== tag);
      this.db
        .update(metadata)
        .set({
          tags: JSON.stringify(filtered),
          about: JSON.stringify(current.about),
        })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rowToMetadata(
        this.db
          .select()
          .from(metadata)
          .where(eq(metadata.item_id, itemId))
          .get()!,
      );
    });
    return removeFn();
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
    const setFn = this.raw.transaction(() => {
      const row = this.db
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], about: [], extensions: {} };
      const extensions = { ...current.extensions, [namespace]: data };
      this.db
        .update(metadata)
        .set({ extensions: JSON.stringify(extensions) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return extensions;
    });
    return setFn();
  }

  async deleteExtension(
    itemId: string,
    namespace: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const deleteFn = this.raw.transaction(() => {
      const row = this.db
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], about: [], extensions: {} };
      const rest = Object.fromEntries(
        Object.entries(current.extensions).filter(([k]) => k !== namespace),
      );
      this.db
        .update(metadata)
        .set({ extensions: JSON.stringify(rest) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rest;
    });
    return deleteFn();
  }
}
