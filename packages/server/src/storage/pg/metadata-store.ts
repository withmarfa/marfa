import { eq, inArray, sql } from "drizzle-orm";
import type { Metadata } from "@mymehq/shared";
import type { MetadataStore } from "../interface.js";
import { items, metadata } from "./schema.js";
import type { PgDb } from "./connection.js";
import { rowToMetadata } from "./helpers.js";

export class PgMetadataStore implements MetadataStore {
  constructor(private db: PgDb) {}

  /**
   * Aggregate distinct tags across items the caller can read.
   * Joins metadata to items to apply tenant + type-permission filtering;
   * excludes trashed items so the picker doesn't surface dead tags.
   */
  async listTags(filters: {
    tenantId?: string;
    allowedTypes?: string[];
  }): Promise<{ tag: string; count: number }[]> {
    const tenantClause = filters.tenantId
      ? sql`AND i.tenant_id = ${filters.tenantId}`
      : sql``;

    let typesClause = sql``;
    if (filters.allowedTypes && filters.allowedTypes.length > 0) {
      const typed = filters.allowedTypes.filter((p) => p !== "*");
      if (typed.length === 0) {
        // includes "*" — no restriction
        typesClause = sql``;
      } else {
        const exact = typed.filter((p) => !p.endsWith(".*"));
        const wildcards = typed
          .filter((p) => p.endsWith(".*"))
          .map((p) => p.slice(0, -1) + "%");
        const parts: ReturnType<typeof sql>[] = [];
        if (exact.length > 0) parts.push(sql`i.type IN ${exact}`);
        for (const w of wildcards) parts.push(sql`i.type LIKE ${w}`);
        if (filters.allowedTypes.includes("*")) {
          // "*" always matches — leave no restriction
        } else if (parts.length > 0) {
          const joined = parts.reduce(
            (acc, part, idx) => (idx === 0 ? part : sql`${acc} OR ${part}`),
            sql``,
          );
          typesClause = sql`AND (${joined})`;
        }
      }
    }

    const result = await this.db.execute(sql`
      SELECT tag, COUNT(*)::int AS count
      FROM (
        SELECT jsonb_array_elements_text(m.tags::jsonb) AS tag
        FROM metadata m
        JOIN items i ON i.id = m.item_id
        WHERE i.state != 'trashed'
          ${tenantClause}
          ${typesClause}
      ) sub
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `);
    void items;
    return result as unknown as { tag: string; count: number }[];
  }

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
