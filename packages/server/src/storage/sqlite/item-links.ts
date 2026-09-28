import { and, eq, inArray, sql } from "drizzle-orm";
import { ErrorCode, MarfaError, getTypeSchema } from "@withmarfa/shared";
import type { Tombstone } from "../interface.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import {
  item_links,
  items,
  link_tombstones,
  natural_key_tombstones,
} from "./schema.js";

type Executor = DrizzleDb | SqliteTxContext;

/** The field a type names as its link, own and never inherited. */
export function linkFieldOf(type: string): string | undefined {
  return getTypeSchema(type)?.link_field;
}

export function linkOf(
  type: string,
  properties: Record<string, unknown>,
): { field: string; value: string } | null {
  const field = linkFieldOf(type);
  if (field === undefined) return null;
  const value = properties[field];
  return typeof value === "string" && value !== "" ? { field, value } : null;
}

function linkTaken(
  type: string,
  field: string,
  value: string,
  holder: string,
): MarfaError {
  return new MarfaError(
    ErrorCode.LINK_TAKEN,
    `Another item of type "${type}" already holds "${value}" in its link, "${field}"`,
    { type, field, value, existing_id: holder },
  );
}

function isLinkViolation(err: unknown): boolean {
  for (let layer = err; layer != null && typeof layer === "object";) {
    const message = (layer as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("item_links.")) {
      return true;
    }
    layer = (layer as { cause?: unknown }).cause;
  }
  return false;
}

/** Holds a row's entry to its type and properties after a write; the
 *  previous type is absent on a create. */
export async function syncLink(
  db: Executor,
  row: { id: string; type: string; properties: Record<string, unknown> },
  previousType?: string,
): Promise<void> {
  const link = linkOf(row.type, row.properties);
  if (previousType !== undefined) {
    // A type naming no link has no entries, so a write between two such
    // types leaves nothing to keep in step.
    if (
      linkFieldOf(previousType) === undefined &&
      linkFieldOf(row.type) === undefined
    ) {
      return;
    }
    const [held] = await db
      .select({ type: item_links.type, value: item_links.value })
      .from(item_links)
      .where(eq(item_links.item_id, row.id))
      .all();
    if (held && link && held.type === row.type && held.value === link.value) {
      return;
    }
    if (held) {
      await db.delete(item_links).where(eq(item_links.item_id, row.id)).run();
    }
  }
  if (!link) return;
  const [holder] = await db
    .select({ item_id: item_links.item_id })
    .from(item_links)
    .where(and(eq(item_links.type, row.type), eq(item_links.value, link.value)))
    .all();
  if (holder && holder.item_id !== row.id) {
    throw linkTaken(row.type, link.field, link.value, holder.item_id);
  }
  try {
    await db
      .insert(item_links)
      .values({ type: row.type, value: link.value, item_id: row.id })
      .run();
  } catch (err) {
    if (!isLinkViolation(err)) throw err;
    const [raced] = await db
      .select({ item_id: item_links.item_id })
      .from(item_links)
      .where(
        and(eq(item_links.type, row.type), eq(item_links.value, link.value)),
      )
      .all();
    throw linkTaken(row.type, link.field, link.value, raced?.item_id ?? "");
  }
  await db
    .delete(link_tombstones)
    .where(
      and(
        eq(link_tombstones.type, row.type),
        eq(link_tombstones.value, link.value),
      ),
    )
    .run();
}

/** A natural key held again is no longer purged, whatever type holds it. */
export async function forgetNaturalKey(
  db: Executor,
  source: string,
  sourceId: string,
): Promise<void> {
  await db
    .delete(natural_key_tombstones)
    .where(
      and(
        eq(natural_key_tombstones.source, source),
        eq(natural_key_tombstones.source_id, sourceId),
      ),
    )
    .run();
}

/** Records each link and natural key the purge of `ids` leaves, under the
 *  row's type; runs before the rows go. */
export async function recordTombstones(
  db: Executor,
  ids: readonly string[],
  now: string,
): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  await db.run(sql`
    INSERT INTO link_tombstones (type, value, purged_at, remembered_until)
    SELECT type, value, ${now}, ${now} FROM item_links
    WHERE ${inArray(item_links.item_id, unique)}
    ON CONFLICT (type, value) DO UPDATE SET
      purged_at = excluded.purged_at,
      remembered_until = max(link_tombstones.remembered_until, excluded.remembered_until)
  `);
  await db.run(sql`
    INSERT INTO natural_key_tombstones (type, source, source_id, purged_at, remembered_until)
    SELECT type, source, source_id, ${now}, ${now} FROM items
    WHERE ${inArray(items.id, unique)}
      AND source IS NOT NULL AND source_id IS NOT NULL
    ON CONFLICT (type, source, source_id) DO UPDATE SET
      purged_at = excluded.purged_at,
      remembered_until = max(natural_key_tombstones.remembered_until, excluded.remembered_until)
  `);
}

export async function rebuildTypeLinks(
  db: Executor,
  type: string,
  field: string | undefined,
): Promise<void> {
  await db.delete(item_links).where(eq(item_links.type, type)).run();
  if (field === undefined) return;
  const path = `$."${field}"`;
  const holds = sql`${items.type} = ${type}
    AND json_type(${items.properties}, ${path}) = 'text'
    AND json_extract(${items.properties}, ${path}) <> ''`;
  const [shared] = await db
    .select({ value: sql<string>`json_extract(${items.properties}, ${path})` })
    .from(items)
    .where(holds)
    .groupBy(sql`json_extract(${items.properties}, ${path})`)
    .having(sql`count(*) > 1`)
    .limit(1)
    .all();
  if (shared) {
    // Names neither row: the caller changing a type may not read its rows.
    throw new MarfaError(
      ErrorCode.LINK_TAKEN,
      `Two or more items of type "${type}" hold the same value in "${field}", so it cannot be their link until one of them changes`,
      { type, field },
    );
  }
  await db.run(sql`
    INSERT INTO item_links (type, value, item_id)
    SELECT ${type}, json_extract(${items.properties}, ${path}), ${items.id}
    FROM ${items} WHERE ${holds}
  `);
  await db.run(sql`
    DELETE FROM link_tombstones WHERE type = ${type}
      AND value IN (SELECT value FROM item_links WHERE type = ${type})
  `);
}

export async function forgetType(db: Executor, type: string): Promise<void> {
  await db.delete(item_links).where(eq(item_links.type, type)).run();
  await db.delete(link_tombstones).where(eq(link_tombstones.type, type)).run();
  await db
    .delete(natural_key_tombstones)
    .where(eq(natural_key_tombstones.type, type))
    .run();
}

function asTombstone(row: {
  key: string;
  purged_at: string;
  remembered_until: string;
}): Tombstone {
  return {
    key: row.key,
    purged_at: row.purged_at,
    remembered_until: row.remembered_until,
  };
}

export async function readLinkTombstones(
  db: Executor,
  type: string,
  values: readonly string[],
): Promise<Tombstone[]> {
  if (values.length === 0) return [];
  const rows = await db
    .select({
      key: link_tombstones.value,
      purged_at: link_tombstones.purged_at,
      remembered_until: link_tombstones.remembered_until,
    })
    .from(link_tombstones)
    .where(
      and(
        eq(link_tombstones.type, type),
        inArray(link_tombstones.value, [...values]),
      ),
    )
    .all();
  return rows.map(asTombstone);
}

export async function readNaturalKeyTombstones(
  db: Executor,
  type: string,
  source: string,
  sourceIds: readonly string[],
): Promise<Tombstone[]> {
  if (sourceIds.length === 0) return [];
  const rows = await db
    .select({
      key: natural_key_tombstones.source_id,
      purged_at: natural_key_tombstones.purged_at,
      remembered_until: natural_key_tombstones.remembered_until,
    })
    .from(natural_key_tombstones)
    .where(
      and(
        eq(natural_key_tombstones.type, type),
        eq(natural_key_tombstones.source, source),
        inArray(natural_key_tombstones.source_id, [...sourceIds]),
      ),
    )
    .all();
  return rows.map(asTombstone);
}

export async function extendLinkTombstones(
  db: Executor,
  type: string,
  values: readonly string[],
  until: string,
): Promise<Tombstone[]> {
  if (values.length === 0) return [];
  await db
    .update(link_tombstones)
    .set({
      remembered_until: sql`max(${link_tombstones.remembered_until}, ${until})`,
    })
    .where(
      and(
        eq(link_tombstones.type, type),
        inArray(link_tombstones.value, [...values]),
      ),
    )
    .run();
  return readLinkTombstones(db, type, values);
}

export async function extendNaturalKeyTombstones(
  db: Executor,
  type: string,
  source: string,
  sourceIds: readonly string[],
  until: string,
): Promise<Tombstone[]> {
  if (sourceIds.length === 0) return [];
  await db
    .update(natural_key_tombstones)
    .set({
      remembered_until: sql`max(${natural_key_tombstones.remembered_until}, ${until})`,
    })
    .where(
      and(
        eq(natural_key_tombstones.type, type),
        eq(natural_key_tombstones.source, source),
        inArray(natural_key_tombstones.source_id, [...sourceIds]),
      ),
    )
    .run();
  return readNaturalKeyTombstones(db, type, source, sourceIds);
}
