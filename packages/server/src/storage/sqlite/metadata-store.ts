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

  /**
   * Aggregate distinct tags across items the caller can read. Uses
   * `json_each` to unnest the tags JSON arrays; tenant + type-permission
   * filtering applied via a join to `items`. Excludes trashed items.
   */
  listTags(filters: {
    tenantId?: string;
    allowedTypes?: string[];
  }): Promise<{ tag: string; count: number }[]> {
    const conditions: string[] = ["i.state != 'trashed'"];
    const params: unknown[] = [];
    if (filters.tenantId) {
      conditions.push("i.tenant_id = ?");
      params.push(filters.tenantId);
    }
    if (filters.allowedTypes && filters.allowedTypes.length > 0) {
      const includesStar = filters.allowedTypes.includes("*");
      if (!includesStar) {
        const typeClauses = filters.allowedTypes.map((pattern) => {
          if (pattern.endsWith(".*")) {
            params.push(pattern.slice(0, -1) + "%");
            return "i.type LIKE ?";
          }
          params.push(pattern);
          return "i.type = ?";
        });
        if (typeClauses.length > 0) {
          conditions.push(`(${typeClauses.join(" OR ")})`);
        }
      }
    }
    const where = conditions.join(" AND ");
    const sqlText = `
      SELECT je.value AS tag, COUNT(*) AS count
      FROM metadata m
      JOIN items i ON i.id = m.item_id, json_each(m.tags) je
      WHERE ${where}
      GROUP BY je.value
      ORDER BY count DESC, tag ASC
    `;
    const rows = this.raw.prepare(sqlText).all(...params) as {
      tag: string;
      count: number;
    }[];
    return Promise.resolve(rows);
  }

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
        (id) => map.get(id) ?? { item_id: id, tags: [], extensions: {} },
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
        extensions: {},
      });
    }
    return Promise.resolve(rowToMetadata(row));
  }

  set(itemId: string, tags: string[]): Promise<Metadata> {
    this.db
      .update(metadata)
      .set({ tags: JSON.stringify(tags) })
      .where(eq(metadata.item_id, itemId))
      .run();
    return this.get(itemId);
  }

  async merge(itemId: string, tags?: string[]): Promise<Metadata> {
    const mergeFn = this.raw.transaction(() => {
      const row = this.db
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const mergedTags = tags
        ? [...new Set([...current.tags, ...tags])]
        : current.tags;
      this.db
        .update(metadata)
        .set({ tags: JSON.stringify(mergedTags) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rowToMetadata(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the SET above guarantees the row exists inside this transaction
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
        : { item_id: itemId, tags: [], extensions: {} };
      const merged = [...new Set([...current.tags, ...tags])];
      this.db
        .update(metadata)
        .set({ tags: JSON.stringify(merged) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rowToMetadata(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the SET above guarantees the row exists inside this transaction
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
        : { item_id: itemId, tags: [], extensions: {} };
      const filtered = current.tags.filter((t) => t !== tag);
      this.db
        .update(metadata)
        .set({ tags: JSON.stringify(filtered) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rowToMetadata(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the SET above guarantees the row exists inside this transaction
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

  getExtensionsForItems(
    itemIds: string[],
  ): Promise<Map<string, Record<string, Record<string, unknown>>>> {
    const out = new Map<string, Record<string, Record<string, unknown>>>();
    if (itemIds.length === 0) return Promise.resolve(out);
    const rows = this.db
      .select({ item_id: metadata.item_id, extensions: metadata.extensions })
      .from(metadata)
      .where(inArray(metadata.item_id, itemIds))
      .all();
    const byId = new Map(rows.map((r) => [r.item_id, r.extensions]));
    for (const id of itemIds) {
      const raw = byId.get(id);
      out.set(
        id,
        raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {},
      );
    }
    return Promise.resolve(out);
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
        : { item_id: itemId, tags: [], extensions: {} };
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
        : { item_id: itemId, tags: [], extensions: {} };
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
