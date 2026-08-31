import { eq, inArray, sql } from "drizzle-orm";
import {
  typePatternToSql,
  typeFilterTerms,
  GLOBAL_TYPE_WILDCARD,
  type Metadata,
} from "@withmarfa/shared";
import type { MetadataStore } from "../interface.js";
import { items, metadata } from "./schema.js";
import type { PgDb } from "./connection.js";
import { rowToMetadata } from "./helpers.js";

export class PgMetadataStore implements MetadataStore {
  constructor(private db: PgDb) {}

  /**
   * Aggregate distinct tags across items the caller can read.
   * Joins metadata to items to apply space + type-permission filtering;
   * excludes trashed items so the picker doesn't surface dead tags.
   */
  async listTags(filters: {
    spaceId?: string;
    allowedTypes?: string[];
    excludedTypes?: string[];
  }): Promise<{ tag: string; count: number }[]> {
    const spaceClause = filters.spaceId
      ? sql`AND i.space_id = ${filters.spaceId}`
      : sql``;

    let typesClause = sql``;
    const excludedTypes = filters.excludedTypes ?? [];
    // An empty allow-list means "no readable types", not "no restriction",
    // and every other read surface reads it that way. Guarding on a non-empty
    // list dropped the clause and returned the whole space's tag vocabulary
    // with counts, which names what exists even when no item behind it is
    // readable.
    //
    // **A global wildcard skips the clause only when nothing is excluded
    // beside it.** A grant of `{"*": "read", "system.credential": "none"}`
    // carries both, and skipping there computes the vocabulary over every
    // type in the space including the withheld one. That was unreachable
    // while `computeTypeFilter` enumerated the wildcard into concrete ids
    // before it arrived; the moment it stopped, this short-circuit became
    // the fail-open path, two files away from the change that re-armed it.
    const unrestricted =
      filters.allowedTypes?.includes(GLOBAL_TYPE_WILDCARD) === true &&
      excludedTypes.length === 0;
    if (filters.allowedTypes && !unrestricted) {
      // A subtree wildcard matches its own root as well as its descendants,
      // so `core.media.*` covers `core.media`.
      const clauseFor = (pattern: string): ReturnType<typeof sql> => {
        const { global, exact, descendantPattern } = typePatternToSql(pattern);
        if (global) return sql`true`;
        if (!exact) return sql`false`;
        if (!descendantPattern) return sql`i.type = ${exact}`;
        return sql`(i.type = ${exact} OR i.type LIKE ${descendantPattern} ESCAPE '\\')`;
      };
      const parts = typeFilterTerms(filters.allowedTypes, excludedTypes).map(
        ({ pattern, minus }) => {
          const granted = clauseFor(pattern);
          if (minus.length === 0) return granted;
          const carved = minus
            .map(clauseFor)
            .reduce((acc, part, idx) =>
              idx === 0 ? part : sql`${acc} OR ${part}`,
            );
          return sql`(${granted} AND NOT (${carved}))`;
        },
      );
      // The seed is what an empty allow-list resolves to: no clause at all
      // would widen the query back to every type.
      const joined = parts.reduce(
        (acc, part, idx) => (idx === 0 ? part : sql`${acc} OR ${part}`),
        sql`false`,
      );
      typesClause = sql`AND (${joined})`;
    }

    const result = await this.db.execute(sql`
      SELECT tag, COUNT(*)::int AS count
      FROM (
        SELECT jsonb_array_elements_text(m.tags::jsonb) AS tag
        FROM metadata m
        JOIN items i ON i.id = m.item_id
        WHERE i.state != 'trashed'
          ${spaceClause}
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

  async getExtensionsForItems(
    itemIds: string[],
  ): Promise<Map<string, Record<string, Record<string, unknown>>>> {
    const out = new Map<string, Record<string, Record<string, unknown>>>();
    if (itemIds.length === 0) return out;
    const rows = await this.db
      .select({ item_id: metadata.item_id, extensions: metadata.extensions })
      .from(metadata)
      .where(inArray(metadata.item_id, itemIds));
    const byId = new Map(rows.map((r) => [r.item_id, r.extensions]));
    for (const id of itemIds) {
      const raw = byId.get(id);
      out.set(
        id,
        raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {},
      );
    }
    return out;
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

  /**
   * `SELECT … FOR UPDATE` is load-bearing: the extensions map is one JSON
   * column, so a plain read-then-write lets a concurrent writer on a
   * different namespace of the same item commit in between and lose one
   * of the two updates. The row lock makes the cycle serializable.
   */
  async mutateExtension(
    itemId: string,
    namespace: string,
    mutate: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .for("update");
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const next = mutate(current.extensions[namespace] ?? {});
      const extensions = { ...current.extensions, [namespace]: next };
      await tx
        .update(metadata)
        .set({ extensions: JSON.stringify(extensions) })
        .where(eq(metadata.item_id, itemId));
      return next;
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
