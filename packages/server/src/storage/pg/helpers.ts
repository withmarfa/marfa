import type { Item, ItemState, Metadata, Version } from "@myme/shared";
import type { items, metadata, versions } from "./schema.js";

type ItemRow = typeof items.$inferSelect;
type MetadataRow = typeof metadata.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

export function rowToItem(row: ItemRow): Item {
  return {
    id: row.id,
    type: row.type,
    state: row.state as ItemState,
    properties: JSON.parse(row.properties) as Record<string, unknown>,
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
    tags: JSON.parse(row.tags) as string[],
    about: JSON.parse(row.about) as string[],
  };
}

export function rowToVersion(row: VersionRow): Version {
  return {
    id: row.id,
    item_id: row.item_id,
    version: row.version,
    properties: JSON.parse(row.properties) as Record<string, unknown>,
    created_at: row.created_at,
    ...(row.device_id != null && { device_id: row.device_id }),
  };
}
