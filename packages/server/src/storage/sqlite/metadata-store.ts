import { eq, inArray, sql } from "drizzle-orm";
import {
  typePatternToSql,
  typeFilterTerms,
  GLOBAL_TYPE_WILDCARD,
  MarfaError,
  ErrorCode,
  type Metadata,
} from "@withmarfa/shared";
import type { MetadataStore, SetExtensionsResult } from "../interface.js";
import { items, metadata } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { rowToMetadata } from "./helpers.js";
import { announcesMetadataChange } from "../../metadata-namespaces.js";
import { MAX_TAGS_PER_ITEM } from "../../tag-limits.js";

export class SqliteMetadataStore implements MetadataStore {
  constructor(private db: DrizzleDb) {}

  /**
   * Aggregate distinct tags across items the caller can read. Uses
   * `json_each` to unnest the tags JSON arrays; space + type-permission
   * filtering applied via a join to `items`. Excludes trashed items.
   */
  async listTags(filters: {
    spaceId?: string;
    allowedTypes?: string[];
    excludedTypes?: string[];
  }): Promise<{ tag: string; count: number }[]> {
    const conditions: string[] = ["i.state != 'trashed'"];
    const params: unknown[] = [];
    if (filters.spaceId) {
      conditions.push("i.space_id = ?");
      params.push(filters.spaceId);
    }
    const excludedTypes = filters.excludedTypes ?? [];
    // An empty allow-list means "no readable types", not "no restriction",
    // and every other read surface reads it that way. Guarding on a non-empty
    // list dropped the clause and returned the whole space's tag vocabulary
    // with counts, which names what exists even when no item behind it is
    // readable.
    //
    // **A global wildcard skips the clause only when nothing is excluded
    // beside it** — see the sibling note in the Postgres store for what
    // re-armed this and why it is two files from the change that did.
    const unrestricted =
      filters.allowedTypes?.includes(GLOBAL_TYPE_WILDCARD) === true &&
      excludedTypes.length === 0;
    if (filters.allowedTypes && !unrestricted) {
      const clauseFor = (pattern: string): string => {
        const { global, exact, descendantPattern } = typePatternToSql(pattern);
        if (global) return "1=1";
        if (!exact) return "1=0";
        if (!descendantPattern) {
          params.push(exact);
          return "i.type = ?";
        }
        params.push(exact, descendantPattern);
        return "(i.type = ? OR i.type LIKE ? ESCAPE '\\')";
      };
      const typeClauses = typeFilterTerms(
        filters.allowedTypes,
        excludedTypes,
      ).map(({ pattern, minus }) => {
        const granted = clauseFor(pattern);
        if (minus.length === 0) return granted;
        return `(${granted} AND NOT (${minus.map(clauseFor).join(" OR ")}))`;
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

  /**
   * The one place this store writes the sidecar, so the item's
   * modification time cannot be left behind by a door added later.
   *
   * A metadata write a client can learn about moves the item's
   * modification time; one that is deliberately invisible does not. Tags
   * always announce, so tags always bump. An extension bumps exactly
   * when it announces, decided by the same predicate the publish door
   * consults rather than by a second list of namespaces here — silent on
   * the stream and loud on catch-up is a worse disagreement than either
   * half alone.
   *
   * The bump matters because an incremental catch-up filters on
   * `items.updated_at`. Leaving it where it was hands a resuming client
   * a short list that looks complete.
   *
   * Returns the modification time it wrote, or `null` when the write
   * announced nothing and the item row was left alone. A caller that
   * publishes the item alongside the write needs the post-bump value:
   * the frame it holds was read before this ran, so announcing that one
   * describes the row as it was rather than as it is.
   */
  private async writeSidecar(
    tx: SqliteTxContext,
    itemId: string,
    write: { tags: string } | { extensions: string; namespaces: string[] },
  ): Promise<string | null> {
    // **The item is written first, and the order is load-bearing.** It
    // reads backwards — this method is about the sidecar, and the item is
    // the afterthought — so it invites being swapped back.
    //
    // SQLite admits one writer at a time, so the deadlock this order
    // prevents is not reachable here; the Postgres store carries the same
    // order because there it is. Kept identical deliberately. These two
    // files are read as a pair, and an ordering that mattered in only one
    // of them would leave the next reader working out which — the answer
    // being easy to get wrong and nothing failing when it is.
    // One bump for the whole write, however many namespaces it carries.
    // Any announcing namespace in the set makes the item's change visible,
    // and a caller writing several together means one change rather than
    // one per namespace.
    let bumpedAt: string | null = null;
    if ("tags" in write || write.namespaces.some(announcesMetadataChange)) {
      bumpedAt = new Date().toISOString();
      await tx
        .update(items)
        .set({ updated_at: bumpedAt })
        .where(eq(items.id, itemId))
        .run();
    }
    await tx
      .update(metadata)
      .set(
        "tags" in write
          ? { tags: write.tags }
          : { extensions: write.extensions },
      )
      .where(eq(metadata.item_id, itemId))
      .run();
    return bumpedAt;
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
    await this.db.transaction(async (tx) => {
      await this.writeSidecar(tx, itemId, { tags: JSON.stringify(tags) });
    });
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
      if (
        mergedTags.length > MAX_TAGS_PER_ITEM &&
        mergedTags.length > current.tags.length
      ) {
        // Inside the transaction that computes the set, on the same read the
        // write uses. See MAX_TAGS_PER_ITEM for why that is the copy that
        // holds, and why it fires only on an increase.
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item (including existing tags)`,
        );
      }
      await this.writeSidecar(tx, itemId, {
        tags: JSON.stringify(mergedTags),
      });
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
      if (
        merged.length > MAX_TAGS_PER_ITEM &&
        merged.length > current.tags.length
      ) {
        // Inside the transaction that computes the set, on the same read the
        // write uses. See MAX_TAGS_PER_ITEM for why that is the copy that
        // holds, and why it fires only on an increase.
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item (including existing tags)`,
        );
      }
      await this.writeSidecar(tx, itemId, { tags: JSON.stringify(merged) });
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
      await this.writeSidecar(tx, itemId, {
        tags: JSON.stringify(filtered),
      });
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
      await this.writeSidecar(tx, itemId, {
        extensions: JSON.stringify(extensions),
        namespaces: [namespace],
      });
      return extensions;
    });
  }

  /**
   * Several namespaces of one item in a single write. The extensions of an
   * item are one JSON column, so writing them one at a time rewrites that
   * column once per namespace and bumps the item's modification time
   * again beside each announcing one. The archive restore holds the whole
   * set before it writes any of it, and that is the caller this exists
   * for: its cost was namespaces times items on the one path whose
   * purpose is moving many rows at once.
   *
   * Replaces each named namespace and leaves the rest of the map alone,
   * which is `setExtension` applied to a set rather than a different
   * merge rule. It carries `setExtension`'s hazard too: a value derived
   * from an earlier read still belongs in `mutateExtension`.
   *
   * Answers the modification time the write left on the item alongside
   * the map, so the caller announcing the item does not publish the value
   * the row held before the bump.
   */
  async setExtensions(
    itemId: string,
    entries: Record<string, Record<string, unknown>>,
  ): Promise<SetExtensionsResult> {
    const namespaces = Object.keys(entries);
    if (namespaces.length === 0) {
      // Nothing written, so nothing moved: the null says "no new
      // modification time", which is different from "the row's current
      // one" and is what a caller announcing the item has to distinguish.
      return { extensions: await this.getExtensions(itemId), updated_at: null };
    }
    return await this.db.transaction(async (tx) => {
      const row = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .get();
      const current: Metadata = row
        ? rowToMetadata(row)
        : { item_id: itemId, tags: [], extensions: {} };
      const extensions = { ...current.extensions, ...entries };
      const updated_at = await this.writeSidecar(tx, itemId, {
        extensions: JSON.stringify(extensions),
        namespaces,
      });
      return { extensions, updated_at };
    });
  }

  /**
   * SQLite has no row-level lock to take; the write transaction is the
   * serialization point, since SQLite admits one writer at a time. The
   * Postgres implementation adds `FOR UPDATE` for the same guarantee.
   *
   * That is also why the Postgres side claims the item row before its
   * metadata lock and this one does not: with no row locks here there is
   * no order between two of them to get wrong.
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
      await this.writeSidecar(tx, itemId, {
        extensions: JSON.stringify(extensions),
        namespaces: [namespace],
      });
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
      await this.writeSidecar(tx, itemId, {
        extensions: JSON.stringify(rest),
        namespaces: [namespace],
      });
      return rest;
    });
  }
}
