import { eq, inArray, sql } from "drizzle-orm";
import { typePatternToSql, type Metadata } from "@withmarfa/shared";
import type { MetadataStore } from "../interface.js";
import { metadata } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { rowToMetadata } from "./helpers.js";

export class SqliteMetadataStore implements MetadataStore {
  constructor(private db: DrizzleDb) {}

  /**
   * Aggregate distinct tags across items the caller can read. Uses
   * `json_each` to unnest the tags JSON arrays; tenant + type-permission
   * filtering applied via a join to `items`. Excludes trashed items.
   */
  async listTags(filters: {
    tenantId?: string;
    allowedTypes?: string[];
  }): Promise<{ tag: string; count: number }[]> {
    const conditions: string[] = ["i.state != 'trashed'"];
    const params: unknown[] = [];
    if (filters.tenantId) {
      conditions.push("i.tenant_id = ?");
      params.push(filters.tenantId);
    }
    // An empty allow-list means "no readable types", not "no restriction",
    // and every other read surface reads it that way. Guarding on a non-empty
    // list dropped the clause and returned the whole tenant's tag vocabulary
    // with counts, which names what exists even when no item behind it is
    // readable.
    if (filters.allowedTypes && !filters.allowedTypes.includes("*")) {
      const typeClauses = filters.allowedTypes.map((pattern) => {
        const { exact, descendantPattern, extraTypes } = typePatternToSql(
          pattern,
          filters.tenantId ?? null,
        );
        if (!exact) return "1=0";
        if (!descendantPattern) {
          params.push(exact);
          return "i.type = ?";
        }
        params.push(exact, descendantPattern);
        if (extraTypes.length === 0) {
          return "(i.type = ? OR i.type LIKE ? ESCAPE '\\')";
        }
        params.push(...extraTypes);
        const placeholders = extraTypes.map(() => "?").join(", ");
        return `(i.type = ? OR i.type LIKE ? ESCAPE '\\' OR i.type IN (${placeholders}))`;
      });
      conditions.push(
        typeClauses.length > 0 ? `(${typeClauses.join(" OR ")})` : "1=0",
      );
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
    // Stitch `?`-split fragments with drizzle parameter binding for each
    // inline value (drizzle's `sql.raw` does not bind, so we can't pass a
    // pre-formatted string with `?`s through it).
    const fragments = sqlText.split("?");
    const builder = sql.empty();
    for (let i = 0; i < fragments.length; i++) {
      builder.append(sql.raw(fragments[i] ?? ""));
      if (i < fragments.length - 1) {
        builder.append(sql`${params[i]}`);
      }
    }
    const rows = await this.db.all<{ tag: string; count: number }>(builder);
    return rows;
  }

  async getMany(itemIds: string[]): Promise<Metadata[]> {
    if (itemIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(metadata)
      .where(inArray(metadata.item_id, itemIds))
      .all();
    const map = new Map(rows.map((r) => [r.item_id, rowToMetadata(r)]));
    return itemIds.map(
      (id) => map.get(id) ?? { item_id: id, tags: [], extensions: {} },
    );
  }

  async get(itemId: string): Promise<Metadata> {
    const row = await this.db
      .select()
      .from(metadata)
      .where(eq(metadata.item_id, itemId))
      .get();
    if (!row) {
      return {
        item_id: itemId,
        tags: [],
        extensions: {},
      };
    }
    return rowToMetadata(row);
  }

  async set(itemId: string, tags: string[]): Promise<Metadata> {
    await this.db
      .update(metadata)
      .set({ tags: JSON.stringify(tags) })
      .where(eq(metadata.item_id, itemId))
      .run();
    return this.get(itemId);
  }

  async merge(itemId: string, tags?: string[]): Promise<Metadata> {
    return await this.db.transaction(async (tx) => {
      const row = await tx
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
      await tx
        .update(metadata)
        .set({ tags: JSON.stringify(mergedTags) })
        .where(eq(metadata.item_id, itemId))
        .run();
      const after = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the SET above guarantees the row exists inside this transaction
      return rowToMetadata(after!);
    });
  }

  async addTags(itemId: string, tags: string[]): Promise<Metadata> {
    return await this.db.transaction(async (tx) => {
      const row = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const merged = [...new Set([...current.tags, ...tags])];
      await tx
        .update(metadata)
        .set({ tags: JSON.stringify(merged) })
        .where(eq(metadata.item_id, itemId))
        .run();
      const after = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the SET above guarantees the row exists inside this transaction
      return rowToMetadata(after!);
    });
  }

  async removeTag(itemId: string, tag: string): Promise<Metadata> {
    return await this.db.transaction(async (tx) => {
      const row = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const filtered = current.tags.filter((t) => t !== tag);
      await tx
        .update(metadata)
        .set({ tags: JSON.stringify(filtered) })
        .where(eq(metadata.item_id, itemId))
        .run();
      const after = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the SET above guarantees the row exists inside this transaction
      return rowToMetadata(after!);
    });
  }

  async getExtensions(
    itemId: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const current = await this.get(itemId);
    return current.extensions;
  }

  async getExtensionsForItems(
    itemIds: string[],
  ): Promise<Map<string, Record<string, Record<string, unknown>>>> {
    const out = new Map<string, Record<string, Record<string, unknown>>>();
    if (itemIds.length === 0) return out;
    const rows = await this.db
      .select({ item_id: metadata.item_id, extensions: metadata.extensions })
      .from(metadata)
      .where(inArray(metadata.item_id, itemIds))
      .all();
    const byId = new Map(rows.map((r) => [r.item_id, r.extensions]));
    for (const id of itemIds) {
      const rawExt = byId.get(id);
      out.set(
        id,
        rawExt
          ? (JSON.parse(rawExt) as Record<string, Record<string, unknown>>)
          : {},
      );
    }
    return out;
  }

  async setExtension(
    itemId: string,
    namespace: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, Record<string, unknown>>> {
    return await this.db.transaction(async (tx) => {
      const row = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const extensions = { ...current.extensions, [namespace]: data };
      await tx
        .update(metadata)
        .set({ extensions: JSON.stringify(extensions) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return extensions;
    });
  }

  /**
   * SQLite has no row-level lock to take; the write transaction is the
   * serialization point, since SQLite admits one writer at a time. The
   * Postgres implementation adds `FOR UPDATE` for the same guarantee.
   */
  async mutateExtension(
    itemId: string,
    namespace: string,
    mutate: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.db.transaction(async (tx) => {
      const row = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const next = mutate(current.extensions[namespace] ?? {});
      const extensions = { ...current.extensions, [namespace]: next };
      await tx
        .update(metadata)
        .set({ extensions: JSON.stringify(extensions) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return next;
    });
  }

  async deleteExtension(
    itemId: string,
    namespace: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    return await this.db.transaction(async (tx) => {
      const row = await tx
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
      await tx
        .update(metadata)
        .set({ extensions: JSON.stringify(rest) })
        .where(eq(metadata.item_id, itemId))
        .run();
      return rest;
    });
  }
}
