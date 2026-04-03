import type { Item, ItemState, Metadata, Version } from "@myme/shared";
import type { items, metadata, versions } from "./schema.js";

type ItemRow = typeof items.$inferSelect;
type MetadataRow = typeof metadata.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

/** Safely parse JSON from a database column, returning a fallback on corruption. */
function safeJsonParse<T>(value: string, fallback: T, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    console.error(
      `Corrupted JSON in database column (${context}): ${value.slice(0, 100)}`,
    );
    return fallback;
  }
}

export function rowToItem(row: ItemRow): Item {
  return {
    id: row.id,
    type: row.type,
    state: row.state as ItemState,
    properties: safeJsonParse<Record<string, unknown>>(
      row.properties,
      {},
      `${row.id} properties`,
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
    timestamp: row.timestamp,
    version: row.version,
    ...(row.source != null && { source: row.source }),
    ...(row.source_id != null && { source_id: row.source_id }),
    ...(row.origin != null && { origin: row.origin }),
    ...(row.schema_version != null && { schema_version: row.schema_version }),
    ...(row.device_id != null && { device_id: row.device_id }),
    parent_id: row.parent_id ?? null,
    thread_id: row.thread_id ?? null,
    ...(row.capture_latitude != null && {
      capture_latitude: row.capture_latitude,
    }),
    ...(row.capture_longitude != null && {
      capture_longitude: row.capture_longitude,
    }),
  };
}

export function rowToMetadata(row: MetadataRow): Metadata {
  return {
    item_id: row.item_id,
    tags: safeJsonParse<string[]>(row.tags, [], `metadata ${row.item_id} tags`),
    about: safeJsonParse<string[]>(
      row.about,
      [],
      `metadata ${row.item_id} about`,
    ),
    extensions: safeJsonParse<Record<string, Record<string, unknown>>>(
      row.extensions,
      {},
      `metadata ${row.item_id} extensions`,
    ),
  };
}

export function rowToVersion(row: VersionRow): Version {
  return {
    id: row.id,
    item_id: row.item_id,
    version: row.version,
    properties: safeJsonParse<Record<string, unknown>>(
      row.properties,
      {},
      `${row.id} properties`,
    ),
    created_at: row.created_at,
    ...(row.device_id != null && { device_id: row.device_id }),
  };
}
