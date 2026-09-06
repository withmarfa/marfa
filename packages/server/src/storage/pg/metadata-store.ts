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
import type { PgDb } from "./connection.js";
import type { PgTxContext } from "./request-context.js";
import { rowToMetadata } from "./helpers.js";
import { announcesMetadataChange } from "../../metadata-namespaces.js";
import { MAX_TAGS_PER_ITEM } from "../../tag-limits.js";

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
    return result as unknown as { tag: string; count: number }[];
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
    tx: PgTxContext,
    itemId: string,
    write: { tags: string } | { extensions: string; namespaces: string[] },
  ): Promise<string | null> {
    // **The item is written first, and the order is load-bearing.** It
    // reads backwards — this method is about the sidecar, and the item is
    // the afterthought — so it invites being swapped back.
    //
    // `ItemStore.update` opens by locking the item row, and two routes
    // call a metadata write inside that same transaction: the
    // natural-key upsert on `POST /items` and the atomic bulk path. Those
    // hold `items` and then want `metadata`. Taking `metadata` first here
    // would leave each holding what the other wants, and Postgres would
    // resolve it by aborting one after `deadlock_timeout` — an
    // intermittent 500 on a write that is otherwise fine. Writing the
    // item first means every path takes the two rows in one order.
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
        .where(eq(items.id, itemId));
    }
    await tx
      .update(metadata)
      .set(
        "tags" in write
          ? { tags: write.tags }
          : { extensions: write.extensions },
      )
      .where(eq(metadata.item_id, itemId));
    return bumpedAt;
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
    await this.db.transaction(async (tx) => {
      // The item row first, then the sidecar, in the order every other
      // writer here takes them. `set` used to need neither lock because it
      // read nothing; it reads the current set now, and taking the sidecar
      // alone would invert the order `merge` and `removeTag` hold.
      await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .for("update");
      const current = row ? rowToMetadata(row).tags : [];
      // Counted on the array as sent rather than on a projection of it,
      // because this writer stores it verbatim: what the row will hold is
      // exactly what arrived. The merging writers count a deduplicated set
      // for the same reason — each counts what it writes.
      if (tags.length > MAX_TAGS_PER_ITEM && tags.length > current.length) {
        // The wholesale replace answers to the same bound as the merging
        // writers, and on the same read the write uses. Fires on an increase
        // only, so a row already over the bound stays rewritable downward —
        // see MAX_TAGS_PER_ITEM.
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item (including existing tags)`,
        );
      }
      await this.writeSidecar(tx, itemId, { tags: JSON.stringify(tags) });
    });
    return this.get(itemId);
  }

  async merge(itemId: string, tags?: string[]): Promise<Metadata> {
    return this.db.transaction(async (tx) => {
      // The item row first, unconditionally. The lock below is on
      // `metadata`, and `writeSidecar` then writes `items`, so taking the
      // sidecar alone inverts the order every other writer here holds —
      // `removeTag` reads then writes `items` then `metadata`, so one
      // `POST /items/{id}/tags` against one `DELETE /items/{id}/tags/{tag}`
      // on the same row is a cycle, and nothing in this package retries a
      // deadlock. `mutateExtension` claims the item row for exactly this
      // reason and asks a predicate first; a tag write always announces, so
      // there is nothing to ask.
      await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .for("update");
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
      return { ...current, tags: mergedTags };
    });
  }

  async addTags(itemId: string, tags: string[]): Promise<Metadata> {
    return this.db.transaction(async (tx) => {
      // The item row first, unconditionally. The lock below is on
      // `metadata`, and `writeSidecar` then writes `items`, so taking the
      // sidecar alone inverts the order every other writer here holds —
      // `removeTag` reads then writes `items` then `metadata`, so one
      // `POST /items/{id}/tags` against one `DELETE /items/{id}/tags/{tag}`
      // on the same row is a cycle, and nothing in this package retries a
      // deadlock. `mutateExtension` claims the item row for exactly this
      // reason and asks a predicate first; a tag write always announces, so
      // there is nothing to ask.
      await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId))
        .for("update");
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
      await this.writeSidecar(tx, itemId, {
        tags: JSON.stringify(filtered),
      });
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
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(metadata)
        .where(eq(metadata.item_id, itemId));
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
      // The lock below is taken on `metadata`, so on the one path that
      // also writes `items` it would invert the order `writeSidecar`
      // exists to hold. Claim the item row first there. Only reached for
      // an announcing namespace: where nothing writes `items`, there are
      // not two rows to order, and the reserved runtime namespaces stay
      // on the single-lock path they have always had.
      if (announcesMetadataChange(namespace)) {
        await tx
          .select({ id: items.id })
          .from(items)
          .where(eq(items.id, itemId))
          .for("update");
      }
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
      await this.writeSidecar(tx, itemId, {
        extensions: JSON.stringify(rest),
        namespaces: [namespace],
      });
      return rest;
    });
  }
}
